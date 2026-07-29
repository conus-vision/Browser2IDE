import {
  ClientSourceSchema,
  InspectMessageSchema,
  PROTOCOL_VERSION,
} from "@browser2ide/protocol";
import type { InspectPayload } from "./bridgeClient.js";
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
  registerPanel(registration: PanelRegistration): { dispose(): void };
  publishInspect(
    windowId: number,
    sourceId: string,
    payload: InspectPayload,
  ): boolean;
  removeWindow(windowId: number): Promise<void>;
}

export type BackgroundRouteResult = { readonly ok: true };

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
}

interface PendingRegistration extends RegistrationIdentity {
  readonly generation: number;
  readonly disposeGeneration: number;
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
}

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
    };
    this.panelPorts.set(channel, record);
    port.onMessage.addListener(record.onMessage);
    port.onDisconnect.addListener(record.onDisconnect);

    const binding = this.bindings.get(channel);
    if (binding) {
      this.activatePanelPort(record, binding);
    }
  }

  public async removeWindow(windowId: number): Promise<void> {
    if (this.disposed || !isBrowserId(windowId)) {
      return;
    }
    this.removedWindows.add(windowId);
    const removedBindings = [...this.bindings.values()].filter(
      (binding) => binding.windowId === windowId,
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
    );
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
      const resolved = resolvedTab(tab, pending.tabId);
      if (!resolved || this.removedWindows.has(resolved.windowId)) {
        return undefined;
      }

      const currentBinding = this.bindings.get(pending.channel);
      if (currentBinding) {
        if (!sameIdentity(currentBinding, pending)) {
          return undefined;
        }
        if (currentBinding.windowId !== resolved.windowId) {
          const replacement: ChannelBinding = {
            channel: pending.channel,
            tabId: pending.tabId,
            sourceId: pending.sourceId,
            windowId: resolved.windowId,
            generation: pending.generation,
          };
          this.bindings.set(replacement.channel, replacement);
          const port = this.panelPorts.get(replacement.channel);
          if (port) {
            this.activatePanelPort(port, replacement);
          }
        }
        return okResult;
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
      (record.bindingGeneration === binding.generation &&
        record.registration !== undefined)
    ) {
      return;
    }

    this.clearPanelActivation(record);
    record.port.onMessage.removeListener(record.onMessage);
    const token = {};
    const session = new BackgroundInspectSession(
      this.inspectCoordinator,
      binding.tabId,
      (result) => this.postToCurrentPort(record, token, result),
    );
    const onMessage = (message: unknown): void => {
      session.handleMessage(message);
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

  private clearPanelActivation(record: PanelPortRecord): void {
    record.activationToken = undefined;
    record.bindingGeneration = undefined;
    const session = record.inspectSession;
    record.inspectSession = undefined;
    session?.disconnect();
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
        error: "Inspect connection is not registered",
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
    const disposeGeneration = this.disposeGeneration;

    let tab: BackgroundTab | undefined;
    try {
      tab = await this.getTab(senderTab.id);
    } catch {
      return undefined;
    }
    const resolved = resolvedTab(tab, senderTab.id);
    if (
      !resolved ||
      this.disposed ||
      disposeGeneration !== this.disposeGeneration ||
      this.removedWindows.has(resolved.windowId) ||
      (senderTab.windowId !== undefined &&
        senderTab.windowId !== resolved.windowId) ||
      binding.windowId !== resolved.windowId ||
      this.bindings.get(binding.channel) !== binding ||
      !this.isCurrentActivation(record, token, binding)
    ) {
      return undefined;
    }

    this.coordinator.publishInspect(
      binding.windowId,
      binding.sourceId,
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
      this.bindings.get(binding.channel) === binding
    );
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
