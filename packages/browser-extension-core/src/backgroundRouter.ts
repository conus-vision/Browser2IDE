import {
  ClientSourceSchema,
  InspectMessageSchema,
  PROTOCOL_VERSION,
  type ClientSource,
} from "@browser2ide/protocol";
import {
  BrowserProtocolError,
  type InspectPayload,
} from "./bridgeClient.js";
import {
  BackgroundInspectSession,
  type BackgroundInspectCoordinator,
} from "./backgroundInspectSession.js";
import {
  INSPECT_CONTENT_LEASE_PORT_NAME,
  isValidDevtoolsChannel,
  parseDevtoolsPanelPortName,
  parseInspectPortRequest,
  type PanelInspectPort,
} from "./inspectPortProtocol.js";
import type {
  BrowserWindowConnectionState,
  PanelRegistration,
} from "./windowConnectionCoordinator.js";
import { parseLinkCode } from "./linkCode.js";

export const DEFAULT_MAX_PANEL_PORTS = 64;

export interface BackgroundTab {
  readonly id?: number;
  readonly windowId?: number;
}

export interface BackgroundMessageSender {
  readonly url?: string;
  readonly tab?: BackgroundTab;
}

export interface BackgroundRuntimePort extends PanelInspectPort {
  readonly sender?: BackgroundMessageSender;
}

export interface BackgroundWindowCoordinator {
  linkWindow(
    windowId: number,
    code: string,
    source: ClientSource,
    signal?: AbortSignal,
  ): Promise<void>;
  unlinkWindow(windowId: number, signal?: AbortSignal): Promise<void>;
  registerPanel(registration: PanelRegistration): { dispose(): void };
  publishInspect(
    windowId: number,
    sourceId: string,
    payload: InspectPayload,
  ): boolean;
  removeWindow(windowId: number): Promise<void>;
}

export type BackgroundCommandError =
  | "invalidCode"
  | "stalePanel"
  | "busy"
  | "rateLimited"
  | "error";

export type BackgroundRouteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: BackgroundCommandError };

export interface BackgroundRouterSubscriptions {
  subscribeRuntimeMessages(
    listener: (
      message: unknown,
      sender: BackgroundMessageSender,
    ) => Promise<BackgroundRouteResult | undefined>,
  ): () => void;
  subscribeRuntimePorts(
    listener: (port: BackgroundRuntimePort) => void,
  ): () => void;
  subscribeWindowRemoved(listener: (windowId: number) => void): () => void;
  subscribeTabDetached(
    listener: (tabId: number, oldWindowId: number) => void,
  ): () => void;
  subscribeTabAttached(
    listener: (tabId: number, newWindowId: number) => void,
  ): () => void;
}

export interface BackgroundRouterOptions {
  readonly expectedDevtoolsUrl?: string;
  readonly expectedPanelUrl?: string;
  readonly maxPanelPorts?: number;
  readonly getTab: (tabId: number) => Promise<BackgroundTab | undefined>;
  readonly coordinator: BackgroundWindowCoordinator;
  readonly inspectCoordinator: BackgroundInspectCoordinator;
  readonly subscriptions?: BackgroundRouterSubscriptions;
  readonly onError?: (error: unknown) => void;
}

interface RegistrationIdentity {
  readonly channel: string;
  readonly tabId: number;
  readonly sourceId: string;
}

interface ChannelBinding extends RegistrationIdentity {
  readonly windowId: number;
  readonly generation: number;
  readonly suspended: boolean;
}

interface PendingRegistration extends RegistrationIdentity {
  readonly generation: number;
  readonly disposeGeneration: number;
  readonly bindingGeneration: number | undefined;
  detachedWindowId?: number;
  promise: Promise<BackgroundRouteResult | undefined>;
}

interface PanelPortRecord {
  readonly channel: string;
  readonly port: BackgroundRuntimePort;
  readonly generation: number;
  readonly onDisconnect: () => void;
  onMessage: (message: unknown) => void;
  activationToken?: object;
  bindingGeneration?: number;
  registration?: { dispose(): void };
  inspectSession?: BackgroundInspectSession;
  inspectCommandTail: Promise<void>;
}

interface PanelCommandRecord {
  readonly commandToken: object;
  readonly activationToken: object;
  readonly bindingGeneration?: number;
  readonly abortController?: AbortController;
}

type PanelWindowCommand =
  | {
      readonly type: "browser2ide.linkWindow";
      readonly channel: string;
      readonly code: string;
    }
  | {
      readonly type: "browser2ide.unlinkWindow";
      readonly channel: string;
    };

const okResult = Object.freeze({ ok: true } as const);

export class BackgroundRouter {
  private readonly expectedDevtoolsUrl: string | undefined;
  private readonly expectedPanelUrl: string | undefined;
  private readonly maxPanelPorts: number;
  private readonly getTab: BackgroundRouterOptions["getTab"];
  private readonly coordinator: BackgroundWindowCoordinator;
  private readonly inspectCoordinator: BackgroundInspectCoordinator;
  private readonly onError: BackgroundRouterOptions["onError"];
  private readonly bindings = new Map<string, ChannelBinding>();
  private readonly channelByTab = new Map<number, string>();
  private readonly channelBySource = new Map<string, string>();
  private readonly pendingRegistrations = new Map<
    string,
    PendingRegistration
  >();
  private readonly panelPorts = new Map<string, PanelPortRecord>();
  private readonly panelCommands = new Map<string, PanelCommandRecord>();
  private readonly removedWindows = new Set<number>();
  private readonly removeSubscriptions: Array<() => void> = [];
  private nextGeneration = 1;
  private disposeGeneration = 1;
  private disposed = false;

  public constructor(options: BackgroundRouterOptions) {
    this.expectedDevtoolsUrl = options.expectedDevtoolsUrl;
    this.expectedPanelUrl = options.expectedPanelUrl;
    this.maxPanelPorts = validPanelPortLimit(options.maxPanelPorts);
    this.getTab = options.getTab;
    this.coordinator = options.coordinator;
    this.inspectCoordinator = options.inspectCoordinator;
    this.onError = options.onError;
    this.attachSubscriptions(options.subscriptions);
  }

  public async routeMessage(
    message: unknown,
    sender: BackgroundMessageSender,
  ): Promise<BackgroundRouteResult | undefined> {
    if (this.disposed) {
      return undefined;
    }

    const registration = parseRegistrationMessage(message);
    if (registration) {
      if (!this.isTrustedDevtoolsSender(sender)) {
        return undefined;
      }
      return this.registerDevtools(registration);
    }

    const command = parsePanelWindowCommand(message);
    if (command) {
      if (!this.isExpectedPanelSender(sender, command.channel)) {
        return undefined;
      }
      const binding = this.bindings.get(command.channel);
      if (!binding) {
        return this.panelPorts.has(command.channel)
          ? { ok: false, error: "stalePanel" }
          : undefined;
      }
      return this.executePanelWindowCommand(command, binding);
    }

    const payload = parseElementSelectedMessage(message);
    if (!payload) {
      return undefined;
    }
    return this.publishSelection(payload, sender);
  }

  public connectPort(port: BackgroundRuntimePort): void {
    if (this.disposed) {
      safeDisconnect(port);
      return;
    }
    if (port.name === INSPECT_CONTENT_LEASE_PORT_NAME) {
      this.connectContentLease(port);
      return;
    }

    const channel = parseDevtoolsPanelPortName(port.name);
    if (
      !channel ||
      !this.isExpectedPanelSender(port.sender, channel) ||
      this.panelPorts.has(channel) ||
      this.panelPorts.size >= this.maxPanelPorts
    ) {
      safeDisconnect(port);
      return;
    }

    let record: PanelPortRecord;
    record = {
      channel,
      port,
      generation: this.allocateGeneration(),
      onDisconnect: () => this.closePanelPort(record, false),
      onMessage: (message) => this.rejectPendingInspect(record, message),
      inspectCommandTail: Promise.resolve(),
    };
    this.panelPorts.set(channel, record);
    port.onMessage.addListener(record.onMessage);
    port.onDisconnect.addListener(record.onDisconnect);

    const binding = this.bindings.get(channel);
    if (binding && !this.pendingRegistrations.has(channel)) {
      this.activatePanelPort(record, binding);
    }
  }

  public async removeWindow(windowId: number): Promise<void> {
    if (this.disposed || !isBrowserId(windowId)) {
      return;
    }
    this.removedWindows.add(windowId);
    const removedBindings = [...this.bindings.values()].filter(
      (binding) => !binding.suspended && binding.windowId === windowId,
    );
    for (const binding of removedBindings) {
      const port = this.panelPorts.get(binding.channel);
      if (port) {
        this.closePanelPort(port, true);
      }
      this.removeBinding(binding);
    }
    await this.coordinator.removeWindow(windowId);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeGeneration += 1;

    for (const removeSubscription of this.removeSubscriptions.splice(0)) {
      try {
        removeSubscription();
      } catch (error) {
        this.reportError(error);
      }
    }
    for (const record of [...this.panelPorts.values()]) {
      this.closePanelPort(record, true);
    }
    this.pendingRegistrations.clear();
    this.panelCommands.clear();
    this.bindings.clear();
    this.channelByTab.clear();
    this.channelBySource.clear();
    this.removedWindows.clear();
  }

  private attachSubscriptions(
    subscriptions: BackgroundRouterSubscriptions | undefined,
  ): void {
    if (!subscriptions) {
      return;
    }
    this.removeSubscriptions.push(
      subscriptions.subscribeRuntimeMessages((message, sender) =>
        this.routeMessage(message, sender),
      ),
      subscriptions.subscribeRuntimePorts((port) => this.connectPort(port)),
      subscriptions.subscribeWindowRemoved((windowId) => {
        void this.removeWindow(windowId).catch((error) =>
          this.reportError(error),
        );
      }),
      subscriptions.subscribeTabDetached((tabId, oldWindowId) => {
        this.suspendDetachedTab(tabId, oldWindowId);
      }),
      subscriptions.subscribeTabAttached((tabId, newWindowId) => {
        this.attachMovedTab(tabId, newWindowId);
      }),
    );
  }

  private suspendDetachedTab(tabId: number, oldWindowId: number): void {
    if (
      this.disposed ||
      !isBrowserId(tabId) ||
      !isBrowserId(oldWindowId)
    ) {
      return;
    }
    for (const pending of this.pendingRegistrations.values()) {
      if (pending.tabId === tabId && this.isCurrentPending(pending)) {
        pending.detachedWindowId = oldWindowId;
      }
    }

    const channel = this.channelByTab.get(tabId);
    const binding = channel ? this.bindings.get(channel) : undefined;
    if (
      !binding ||
      binding.tabId !== tabId ||
      binding.windowId !== oldWindowId ||
      binding.suspended
    ) {
      return;
    }

    const suspended: ChannelBinding = {
      ...binding,
      generation: this.allocateGeneration(),
      suspended: true,
    };
    this.bindings.set(suspended.channel, suspended);
    const record = this.panelPorts.get(suspended.channel);
    if (record) {
      this.clearPanelActivation(record, true);
    }
  }

  private attachMovedTab(tabId: number, newWindowId: number): void {
    if (
      this.disposed ||
      !isBrowserId(tabId) ||
      !isBrowserId(newWindowId)
    ) {
      return;
    }
    const channel = this.channelByTab.get(tabId);
    const binding = channel ? this.bindings.get(channel) : undefined;
    if (binding) {
      if (binding.tabId !== tabId || !binding.suspended) {
        return;
      }
      const replacement = this.replaceBindingWindow(binding, newWindowId);
      const record = this.panelPorts.get(replacement.channel);
      if (record) {
        this.activatePanelPort(record, replacement);
      }
      return;
    }

    const pending = [...this.pendingRegistrations.values()]
      .filter(
        (candidate) =>
          candidate.tabId === tabId &&
          candidate.detachedWindowId !== undefined &&
          this.isCurrentPending(candidate),
      )
      .sort((left, right) => right.generation - left.generation)[0];
    if (
      !pending ||
      (this.channelBySource.has(pending.sourceId) &&
        this.channelBySource.get(pending.sourceId) !== pending.channel)
    ) {
      return;
    }
    const replacement: ChannelBinding = {
      channel: pending.channel,
      tabId: pending.tabId,
      sourceId: pending.sourceId,
      windowId: newWindowId,
      generation: this.allocateGeneration(),
      suspended: false,
    };
    this.bindings.set(replacement.channel, replacement);
    this.channelByTab.set(replacement.tabId, replacement.channel);
    this.channelBySource.set(replacement.sourceId, replacement.channel);
    const record = this.panelPorts.get(replacement.channel);
    if (record) {
      this.activatePanelPort(record, replacement);
    }
  }

  private replaceBindingWindow(
    binding: ChannelBinding,
    windowId: number,
  ): ChannelBinding {
    const replacement: ChannelBinding = {
      channel: binding.channel,
      tabId: binding.tabId,
      sourceId: binding.sourceId,
      windowId,
      generation: this.allocateGeneration(),
      suspended: false,
    };
    this.bindings.set(replacement.channel, replacement);
    return replacement;
  }

  private registerDevtools(
    identity: RegistrationIdentity,
  ): Promise<BackgroundRouteResult | undefined> {
    const currentBinding = this.bindings.get(identity.channel);
    if (currentBinding && !sameIdentity(currentBinding, identity)) {
      return Promise.resolve(undefined);
    }
    const currentPending = this.pendingRegistrations.get(identity.channel);
    if (currentPending) {
      return sameIdentity(currentPending, identity)
        ? currentPending.promise
        : Promise.resolve(undefined);
    }

    const pending: PendingRegistration = {
      ...identity,
      generation: this.allocateGeneration(),
      disposeGeneration: this.disposeGeneration,
      bindingGeneration: currentBinding?.generation,
      promise: Promise.resolve(undefined),
    };
    this.pendingRegistrations.set(identity.channel, pending);
    pending.promise = this.resolveRegistration(pending);
    return pending.promise;
  }

  private async resolveRegistration(
    pending: PendingRegistration,
  ): Promise<BackgroundRouteResult | undefined> {
    try {
      let tab: BackgroundTab | undefined;
      try {
        tab = await this.getTab(pending.tabId);
      } catch {
        return undefined;
      }
      if (!this.isCurrentPending(pending)) {
        return undefined;
      }
      const currentBinding = this.bindings.get(pending.channel);
      if (currentBinding) {
        if (!sameIdentity(currentBinding, pending)) {
          return undefined;
        }
        if (
          pending.bindingGeneration === undefined ||
          currentBinding.generation !== pending.bindingGeneration
        ) {
          const resolved = resolvedTab(tab, pending.tabId);
          const activeBinding =
            currentBinding.suspended &&
            resolved &&
            !this.removedWindows.has(resolved.windowId) &&
            currentBinding.windowId !== resolved.windowId
              ? this.replaceBindingWindow(currentBinding, resolved.windowId)
              : currentBinding;
          if (activeBinding.suspended) {
            return undefined;
          }
          const port = this.panelPorts.get(activeBinding.channel);
          if (port) {
            this.activatePanelPort(port, activeBinding);
          }
          return okResult;
        }
      }

      const resolved = resolvedTab(tab, pending.tabId);
      if (!resolved || this.removedWindows.has(resolved.windowId)) {
        return undefined;
      }

      if (currentBinding) {
        let activeBinding = currentBinding;
        if (currentBinding.windowId !== resolved.windowId) {
          const replacement: ChannelBinding = {
            channel: pending.channel,
            tabId: pending.tabId,
            sourceId: pending.sourceId,
            windowId: resolved.windowId,
            generation: pending.generation,
            suspended: false,
          };
          this.bindings.set(replacement.channel, replacement);
          activeBinding = replacement;
        }
        const port = this.panelPorts.get(activeBinding.channel);
        if (port) {
          this.activatePanelPort(port, activeBinding);
        }
        return okResult;
      }
      if (pending.bindingGeneration !== undefined) {
        return undefined;
      }
      if (pending.detachedWindowId === resolved.windowId) {
        return undefined;
      }

      const tabChannel = this.channelByTab.get(pending.tabId);
      const supersededBinding =
        tabChannel && tabChannel !== pending.channel
          ? this.bindings.get(tabChannel)
          : undefined;
      if (
        tabChannel &&
        tabChannel !== pending.channel &&
        (!supersededBinding ||
          supersededBinding.tabId !== pending.tabId ||
          supersededBinding.generation > pending.generation)
      ) {
        return undefined;
      }
      const sourceChannel = this.channelBySource.get(pending.sourceId);
      if (sourceChannel && sourceChannel !== pending.channel) {
        const sourceBinding = this.bindings.get(sourceChannel);
        if (
          !sourceBinding ||
          sourceBinding.tabId !== pending.tabId ||
          sourceBinding !== supersededBinding
        ) {
          return undefined;
        }
      }
      if (!this.isCurrentPending(pending)) {
        return undefined;
      }

      const binding: ChannelBinding = {
        channel: pending.channel,
        tabId: pending.tabId,
        sourceId: pending.sourceId,
        windowId: resolved.windowId,
        generation: pending.generation,
        suspended: false,
      };
      if (supersededBinding) {
        const supersededPort = this.panelPorts.get(
          supersededBinding.channel,
        );
        if (supersededPort) {
          this.closePanelPort(supersededPort, true);
        }
        this.removeBinding(supersededBinding);
      }
      this.bindings.set(binding.channel, binding);
      this.channelByTab.set(binding.tabId, binding.channel);
      this.channelBySource.set(binding.sourceId, binding.channel);
      const port = this.panelPorts.get(binding.channel);
      if (port) {
        this.activatePanelPort(port, binding);
      }
      return okResult;
    } finally {
      if (this.pendingRegistrations.get(pending.channel) === pending) {
        this.pendingRegistrations.delete(pending.channel);
      }
    }
  }

  private activatePanelPort(
    record: PanelPortRecord,
    binding: ChannelBinding,
  ): void {
    if (
      this.panelPorts.get(record.channel) !== record ||
      this.bindings.get(binding.channel) !== binding ||
      binding.suspended ||
      (record.bindingGeneration === binding.generation &&
        record.registration !== undefined)
    ) {
      return;
    }

    this.clearPanelActivation(record, true);
    record.port.onMessage.removeListener(record.onMessage);
    const token = {};
    const session = new BackgroundInspectSession(
      this.inspectCoordinator,
      binding.tabId,
      (result) => this.postToCurrentPort(record, token, result),
    );
    const onMessage = (message: unknown): void => {
      this.queueInspectRequest(record, token, message);
    };
    record.onMessage = onMessage;
    record.activationToken = token;
    record.bindingGeneration = binding.generation;
    record.inspectSession = session;
    record.port.onMessage.addListener(onMessage);

    let registration: { dispose(): void };
    try {
      registration = this.coordinator.registerPanel({
        windowId: binding.windowId,
        tabId: binding.tabId,
        sourceId: binding.sourceId,
        onStateChanged: (state) =>
          this.postWindowState(record, token, state),
      });
    } catch (error) {
      this.reportError(error);
      this.closePanelPort(record, true);
      return;
    }

    if (!this.isCurrentActivation(record, token, binding)) {
      registration.dispose();
      session.disconnect();
      return;
    }
    record.registration = registration;
  }

  private clearPanelActivation(
    record: PanelPortRecord,
    settlePendingInspect = false,
  ): void {
    const activationToken = record.activationToken;
    const session = record.inspectSession;
    record.inspectSession = undefined;
    if (settlePendingInspect) {
      session?.retire("stalePanel");
    } else {
      session?.disconnect();
    }
    record.activationToken = undefined;
    record.bindingGeneration = undefined;
    if (activationToken) {
      this.abortPanelCommand(record, activationToken);
    }
    const registration = record.registration;
    record.registration = undefined;
    registration?.dispose();
  }

  private closePanelPort(record: PanelPortRecord, disconnect: boolean): void {
    if (this.panelPorts.get(record.channel) !== record) {
      return;
    }
    this.panelPorts.delete(record.channel);
    record.port.onMessage.removeListener(record.onMessage);
    record.port.onDisconnect.removeListener(record.onDisconnect);
    this.clearPanelActivation(record);
    if (disconnect) {
      safeDisconnect(record.port);
    }
  }

  private rejectPendingInspect(
    record: PanelPortRecord,
    message: unknown,
  ): void {
    const request = parseInspectPortRequest(message);
    if (!request || this.panelPorts.get(record.channel) !== record) {
      return;
    }
    try {
      record.port.postMessage({
        type: "browser2ide.inspect.result",
        requestId: request.requestId,
        ok: false,
        error: "stalePanel",
      });
    } catch {
      // Port teardown owns eventual cleanup.
    }
  }

  private async executePanelWindowCommand(
    command: PanelWindowCommand,
    binding: ChannelBinding,
  ): Promise<BackgroundRouteResult> {
    const record = this.panelPorts.get(command.channel);
    const activationToken = record?.activationToken;
    if (
      !record ||
      !activationToken ||
      !record.registration ||
      !this.isCurrentActivation(record, activationToken, binding)
    ) {
      return { ok: false, error: "stalePanel" };
    }
    const pendingCommand = this.panelCommands.get(command.channel);
    if (pendingCommand?.activationToken === activationToken) {
      return { ok: false, error: "busy" };
    }

    if (command.type === "browser2ide.linkWindow") {
      try {
        parseLinkCode(command.code);
      } catch {
        return { ok: false, error: "invalidCode" };
      }
    }

    const commandToken = {};
    const pendingRecord: PanelCommandRecord = {
      commandToken,
      activationToken,
    };
    this.panelCommands.set(command.channel, pendingRecord);
    let dispatchedBinding: ChannelBinding | undefined;
    let dispatchedCommand: PanelCommandRecord | undefined;
    try {
      const refreshed = await this.refreshPanelBinding(
        binding,
        record,
        activationToken,
      );
      const currentActivationToken = record.activationToken;
      if (
        !refreshed ||
        !currentActivationToken ||
        !record.registration ||
        this.panelCommands.get(command.channel)?.commandToken !== commandToken ||
        !this.isCurrentActivation(
          record,
          currentActivationToken,
          refreshed,
        )
      ) {
        return { ok: false, error: "stalePanel" };
      }
      let source: ClientSource;
      try {
        source = ClientSourceSchema.parse({
          role: "browser",
          id: refreshed.sourceId,
          metadata: {},
        });
      } catch {
        return { ok: false, error: "stalePanel" };
      }

      const abortController = new AbortController();
      const dispatchedRecord: PanelCommandRecord = {
        commandToken,
        activationToken: currentActivationToken,
        bindingGeneration: refreshed.generation,
        abortController,
      };
      this.panelCommands.set(command.channel, dispatchedRecord);
      dispatchedBinding = refreshed;
      dispatchedCommand = dispatchedRecord;

      if (command.type === "browser2ide.linkWindow") {
        await this.coordinator.linkWindow(
          refreshed.windowId,
          command.code,
          source,
          abortController.signal,
        );
      } else {
        await this.coordinator.unlinkWindow(
          refreshed.windowId,
          abortController.signal,
        );
      }
      if (!this.isCurrentPanelCommand(record, refreshed, dispatchedRecord)) {
        return { ok: false, error: "stalePanel" };
      }
      // A completed coordinator side effect cannot always be rolled back. The
      // postflight prevents acknowledging it to a panel that silently moved.
      const postflight = await this.refreshPanelBinding(
        refreshed,
        record,
        dispatchedRecord.activationToken,
      );
      if (
        postflight !== refreshed ||
        !this.isCurrentPanelCommand(record, refreshed, dispatchedRecord)
      ) {
        return { ok: false, error: "stalePanel" };
      }
      return okResult;
    } catch (error) {
      if (!dispatchedBinding || !dispatchedCommand) {
        return { ok: false, error: "stalePanel" };
      }
      const postflight = await this.refreshPanelBinding(
        dispatchedBinding,
        record,
        dispatchedCommand.activationToken,
      );
      if (
        postflight !== dispatchedBinding ||
        !this.isCurrentPanelCommand(
          record,
          dispatchedBinding,
          dispatchedCommand,
        )
      ) {
        return { ok: false, error: "stalePanel" };
      }
      const commandError = sanitizedCommandError(error);
      if (commandError === "error") {
        this.reportError(new Error("Browser2IDE panel command failed"));
      }
      return { ok: false, error: commandError };
    } finally {
      if (
        this.panelCommands.get(command.channel)?.commandToken === commandToken
      ) {
        this.panelCommands.delete(command.channel);
      }
    }
  }

  private queueInspectRequest(
    record: PanelPortRecord,
    activationToken: object,
    message: unknown,
  ): void {
    const request = parseInspectPortRequest(message);
    if (!request) {
      return;
    }
    const operation = record.inspectCommandTail.then(async () => {
      const binding = this.bindings.get(record.channel);
      if (
        !binding ||
        !this.isCurrentActivation(record, activationToken, binding)
      ) {
        this.postInspectFailure(record, request.requestId);
        return;
      }

      const refreshed = await this.refreshPanelBinding(
        binding,
        record,
        activationToken,
      );
      const currentToken = record.activationToken;
      const session = record.inspectSession;
      if (
        !refreshed ||
        !currentToken ||
        !session ||
        !this.isCurrentActivation(record, currentToken, refreshed)
      ) {
        this.postInspectFailure(record, request.requestId);
        return;
      }

      const outcome = await session.execute(request);
      if (!outcome || outcome.delivered) {
        return;
      }
      if (
        record.activationToken !== currentToken ||
        record.inspectSession !== session ||
        !this.isCurrentActivation(record, currentToken, refreshed)
      ) {
        this.postInspectFailure(record, request.requestId);
        return;
      }
      const postflight = await this.refreshPanelBinding(
        refreshed,
        record,
        currentToken,
      );
      if (
        postflight !== refreshed ||
        record.activationToken !== currentToken ||
        record.inspectSession !== session ||
        !this.isCurrentActivation(record, currentToken, refreshed)
      ) {
        this.postInspectFailure(record, request.requestId);
        return;
      }
      this.postToCurrentPort(record, currentToken, outcome.result);
    });
    record.inspectCommandTail = operation.catch((error) => {
      this.reportError(error);
      this.postInspectFailure(record, request.requestId);
    });
  }

  private async refreshPanelBinding(
    binding: ChannelBinding,
    record: PanelPortRecord,
    activationToken: object,
  ): Promise<ChannelBinding | undefined> {
    if (!this.isCurrentActivation(record, activationToken, binding)) {
      return undefined;
    }

    let tab: BackgroundTab | undefined;
    try {
      tab = await this.getTab(binding.tabId);
    } catch {
      tab = undefined;
    }
    if (!this.isCurrentActivation(record, activationToken, binding)) {
      return undefined;
    }

    const resolved = resolvedTab(tab, binding.tabId);
    if (!resolved || this.removedWindows.has(resolved.windowId)) {
      this.invalidatePanelBinding(binding, record);
      return undefined;
    }
    if (binding.windowId === resolved.windowId) {
      return binding;
    }

    const replacement: ChannelBinding = {
      channel: binding.channel,
      tabId: binding.tabId,
      sourceId: binding.sourceId,
      windowId: resolved.windowId,
      generation: this.allocateGeneration(),
      suspended: false,
    };
    this.bindings.set(replacement.channel, replacement);
    this.activatePanelPort(record, replacement);
    const replacementToken = record.activationToken;
    return replacementToken &&
        record.registration &&
        this.isCurrentActivation(record, replacementToken, replacement)
      ? replacement
      : undefined;
  }

  private invalidatePanelBinding(
    binding: ChannelBinding,
    record: PanelPortRecord,
  ): void {
    if (
      this.bindings.get(binding.channel) !== binding ||
      this.panelPorts.get(record.channel) !== record
    ) {
      return;
    }
    this.removeBinding(binding);
    record.port.onMessage.removeListener(record.onMessage);
    this.clearPanelActivation(record, true);
    record.onMessage = (message) => this.rejectPendingInspect(record, message);
    record.port.onMessage.addListener(record.onMessage);
  }

  private postInspectFailure(
    record: PanelPortRecord,
    requestId: string,
  ): void {
    if (this.panelPorts.get(record.channel) !== record) {
      return;
    }
    try {
      record.port.postMessage({
        type: "browser2ide.inspect.result",
        requestId,
        ok: false,
        error: "stalePanel",
      });
    } catch {
      // Port teardown owns eventual cleanup.
    }
  }

  private connectContentLease(port: BackgroundRuntimePort): void {
    const tabId = port.sender?.tab?.id;
    if (!isBrowserId(tabId)) {
      safeDisconnect(port);
      return;
    }
    this.inspectCoordinator.attachContentLease(tabId, port);
  }

  private async publishSelection(
    payload: InspectPayload,
    sender: BackgroundMessageSender,
  ): Promise<BackgroundRouteResult | undefined> {
    const senderTab = validatedSenderTab(sender);
    if (!senderTab) {
      return undefined;
    }
    const channel = this.channelByTab.get(senderTab.id);
    const binding = channel ? this.bindings.get(channel) : undefined;
    const record = channel ? this.panelPorts.get(channel) : undefined;
    if (
      !binding ||
      !record ||
      record.bindingGeneration !== binding.generation ||
      !record.registration ||
      !record.activationToken
    ) {
      return undefined;
    }
    const token = record.activationToken;
    const refreshed = await this.refreshPanelBinding(binding, record, token);
    if (
      !refreshed ||
      (senderTab.windowId !== undefined &&
        senderTab.windowId !== refreshed.windowId)
    ) {
      return undefined;
    }

    this.coordinator.publishInspect(
      refreshed.windowId,
      refreshed.sourceId,
      payload,
    );
    return okResult;
  }

  private postWindowState(
    record: PanelPortRecord,
    token: object,
    state: BrowserWindowConnectionState,
  ): void {
    this.postToCurrentPort(record, token, {
      type: "browser2ide.windowState",
      state,
    });
  }

  private postToCurrentPort(
    record: PanelPortRecord,
    token: object,
    message: unknown,
  ): void {
    if (
      this.panelPorts.get(record.channel) !== record ||
      record.activationToken !== token
    ) {
      return;
    }
    try {
      record.port.postMessage(message);
    } catch {
      // A disappearing panel is finalized by its disconnect event.
    }
  }

  private isCurrentPending(pending: PendingRegistration): boolean {
    return (
      !this.disposed &&
      pending.disposeGeneration === this.disposeGeneration &&
      this.pendingRegistrations.get(pending.channel) === pending
    );
  }

  private isCurrentActivation(
    record: PanelPortRecord,
    token: object,
    binding: ChannelBinding,
  ): boolean {
    return (
      !this.disposed &&
      this.panelPorts.get(record.channel) === record &&
      record.activationToken === token &&
      record.bindingGeneration === binding.generation &&
      !binding.suspended &&
      this.bindings.get(binding.channel) === binding
    );
  }

  private isCurrentPanelCommand(
    record: PanelPortRecord,
    binding: ChannelBinding,
    command: PanelCommandRecord,
  ): boolean {
    return (
      this.panelCommands.get(record.channel) === command &&
      command.bindingGeneration === binding.generation &&
      command.abortController !== undefined &&
      !command.abortController.signal.aborted &&
      this.isCurrentActivation(record, command.activationToken, binding)
    );
  }

  private abortPanelCommand(
    record: PanelPortRecord,
    activationToken: object,
  ): void {
    const command = this.panelCommands.get(record.channel);
    if (
      command?.activationToken === activationToken &&
      command.abortController
    ) {
      command.abortController.abort();
    }
  }

  private removeBinding(binding: ChannelBinding): void {
    if (this.bindings.get(binding.channel) !== binding) {
      return;
    }
    this.bindings.delete(binding.channel);
    if (this.channelByTab.get(binding.tabId) === binding.channel) {
      this.channelByTab.delete(binding.tabId);
    }
    if (this.channelBySource.get(binding.sourceId) === binding.channel) {
      this.channelBySource.delete(binding.sourceId);
    }
  }

  private isTrustedDevtoolsSender(sender: BackgroundMessageSender): boolean {
    return (
      typeof this.expectedDevtoolsUrl === "string" &&
      this.expectedDevtoolsUrl.length > 0 &&
      sender.url === this.expectedDevtoolsUrl
    );
  }

  private isExpectedPanelSender(
    sender: BackgroundMessageSender | undefined,
    channel: string,
  ): boolean {
    if (
      typeof this.expectedPanelUrl !== "string" ||
      this.expectedPanelUrl.length === 0 ||
      typeof sender?.url !== "string"
    ) {
      return false;
    }
    try {
      const expected = new URL(this.expectedPanelUrl);
      expected.search = "";
      expected.hash = "";
      expected.searchParams.set("channel", channel);
      return sender.url === expected.href;
    } catch {
      return false;
    }
  }

  private allocateGeneration(): number {
    const generation = this.nextGeneration;
    this.nextGeneration += 1;
    return generation;
  }

  private reportError(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Diagnostics cannot break background ownership.
    }
  }
}

export function createBackgroundRouter(
  options: BackgroundRouterOptions,
): BackgroundRouter {
  return new BackgroundRouter(options);
}

function parseRegistrationMessage(
  value: unknown,
): RegistrationIdentity | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["type", "channel", "tabId", "sourceId"]) ||
    value.type !== "browser2ide.registerDevtools" ||
    !isValidDevtoolsChannel(value.channel) ||
    !isBrowserId(value.tabId) ||
    typeof value.sourceId !== "string"
  ) {
    return undefined;
  }
  const source = ClientSourceSchema.safeParse({
    role: "browser",
    id: value.sourceId,
    metadata: {},
  });
  return source.success
    ? {
        channel: value.channel,
        tabId: value.tabId,
        sourceId: source.data.id,
      }
    : undefined;
}

function parsePanelWindowCommand(
  value: unknown,
): PanelWindowCommand | undefined {
  if (!isRecord(value) || !isValidDevtoolsChannel(value.channel)) {
    return undefined;
  }
  if (
    value.type === "browser2ide.linkWindow" &&
    hasOnlyKeys(value, ["type", "channel", "code"]) &&
    typeof value.code === "string" &&
    /^[0-9]{7}$/.test(value.code)
  ) {
    return {
      type: "browser2ide.linkWindow",
      channel: value.channel,
      code: value.code,
    };
  }
  if (
    value.type === "browser2ide.unlinkWindow" &&
    hasOnlyKeys(value, ["type", "channel"])
  ) {
    return {
      type: "browser2ide.unlinkWindow",
      channel: value.channel,
    };
  }
  return undefined;
}

function parseElementSelectedMessage(value: unknown): InspectPayload | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["type", "payload"]) ||
    value.type !== "elementSelected" ||
    !isRecord(value.payload)
  ) {
    return undefined;
  }
  try {
    const parsed = InspectMessageSchema.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      messageId: "background-payload-validation",
      type: "inspect",
      sessionId: "background-payload-validation",
      source: {
        role: "browser",
        id: "background-payload-validation",
        metadata: {},
      },
      targets: value.payload.targets,
      context: value.payload.context,
      metadata: value.payload.metadata,
    });
    return parsed.success
      ? {
          targets: parsed.data.targets,
          context: parsed.data.context,
          metadata: parsed.data.metadata,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function validatedSenderTab(
  sender: BackgroundMessageSender,
): { readonly id: number; readonly windowId?: number } | undefined {
  const id = sender.tab?.id;
  const windowId = sender.tab?.windowId;
  if (
    !isBrowserId(id) ||
    (windowId !== undefined && !isBrowserId(windowId))
  ) {
    return undefined;
  }
  return windowId === undefined ? { id } : { id, windowId };
}

function resolvedTab(
  tab: BackgroundTab | undefined,
  expectedTabId: number,
): { readonly id: number; readonly windowId: number } | undefined {
  return tab && tab.id === expectedTabId && isBrowserId(tab.windowId)
    ? { id: expectedTabId, windowId: tab.windowId }
    : undefined;
}

function sameIdentity(
  left: RegistrationIdentity,
  right: RegistrationIdentity,
): boolean {
  return (
    left.channel === right.channel &&
    left.tabId === right.tabId &&
    left.sourceId === right.sourceId
  );
}

function validPanelPortLimit(value: number | undefined): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Math.min(Number(value), 1_024)
    : DEFAULT_MAX_PANEL_PORTS;
}

function sanitizedCommandError(error: unknown): BackgroundCommandError {
  if (error instanceof BrowserProtocolError) {
    if (error.code === "link.rateLimited") {
      return "rateLimited";
    }
    if (error.code === "link.invalidCode") {
      return "invalidCode";
    }
  }
  return "error";
}

function isBrowserId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length &&
    actual.every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function safeDisconnect(port: { disconnect(): void }): void {
  try {
    port.disconnect();
  } catch {
    // Teardown remains best effort after browser-side disconnect.
  }
}
