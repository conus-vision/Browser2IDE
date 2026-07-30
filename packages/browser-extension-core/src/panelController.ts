import { parseLinkCode } from "./linkCode.js";
import { parseInspectPortInvalidated } from "./inspectPortProtocol.js";
import {
  ClipboardPaste,
  MousePointer2,
  RefreshCw,
  Unlink,
  createIcons,
} from "lucide";

export type PanelOperationalState =
  | "notLinked"
  | "linking"
  | "connected"
  | "reconnecting"
  | "offline"
  | "rateLimited"
  | "error";

export type PanelCommand =
  | {
      readonly type: "browser2ide.linkWindow";
      readonly channel: string;
      readonly code: string;
    }
  | {
      readonly type: "browser2ide.unlinkWindow";
      readonly channel: string;
    };

export interface PanelActions {
  readonly onPaste: () => void | Promise<void>;
  readonly onLink: () => void | Promise<void>;
  readonly onChangeIde: () => void | Promise<void>;
  readonly onUnlink: () => void | Promise<void>;
  readonly onInspectChanged: (enabled: boolean) => void | Promise<void>;
  readonly onLinkCodeChanged: (value: string) => void;
}

export interface PanelViewModel {
  readonly state: PanelOperationalState;
  readonly statusLabel: string;
  readonly errorText?: string;
  readonly showLinkControls: boolean;
  readonly showConnectedControls: boolean;
  readonly linkInputDisabled: boolean;
  readonly linkButtonDisabled: boolean;
  readonly pasteButtonDisabled: boolean;
  readonly changeButtonDisabled: boolean;
  readonly unlinkButtonDisabled: boolean;
  readonly inspectDisabled: boolean;
  readonly inspectChecked: boolean;
}

export interface PanelView {
  bind(actions: PanelActions): () => void;
  readLinkCode(): string;
  writeLinkCode(value: string): void;
  render(model: PanelViewModel): void;
}

export interface PanelInspectModeController {
  readonly enabled: boolean;
  setEnabled(enabled: boolean): Promise<void>;
  disable(): Promise<void>;
  handleTransportDisconnect(): void;
}

export interface PanelControllerOptions {
  readonly channel: string;
  readonly view: PanelView;
  readonly inspectController: PanelInspectModeController;
  readonly readClipboard: () => Promise<string>;
  readonly sendCommand: (message: PanelCommand) => Promise<unknown>;
  readonly subscribeWindowState: (
    listener: (message: unknown) => void | Promise<void>,
  ) => () => void;
}

type PanelCommandError =
  | "invalidCode"
  | "stalePanel"
  | "busy"
  | "rateLimited"
  | "error";

type PanelCommandResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: PanelCommandError };

const statusLabels: Readonly<Record<PanelOperationalState, string>> = {
  notLinked: "Not linked",
  linking: "Linking",
  connected: "Connected",
  reconnecting: "Reconnecting",
  offline: "Linked IDE offline",
  rateLimited: "Rate limited",
  error: "Error",
};

export function createPanelIcons(): void {
  createIcons({
    icons: {
      ClipboardPaste,
      MousePointer2,
      RefreshCw,
      Unlink,
    },
    attrs: {
      width: "15",
      height: "15",
      "aria-hidden": "true",
    },
  });
}

export class PanelController {
  private readonly channel: string;
  private readonly view: PanelView;
  private readonly inspectController: PanelInspectModeController;
  private readonly readClipboard: () => Promise<string>;
  private readonly sendCommand: (message: PanelCommand) => Promise<unknown>;
  private readonly subscribeWindowState: PanelControllerOptions["subscribeWindowState"];
  private removeViewBindings: (() => void) | undefined;
  private removeStateSubscription: (() => void) | undefined;
  private state: PanelOperationalState = "notLinked";
  private errorText: string | undefined;
  private hasLinkIntent = false;
  private changingIde = false;
  private busy = false;
  private operationGeneration = 0;
  private pendingLinkGeneration: number | undefined;
  private initialized = false;
  private disposed = false;

  public constructor(options: PanelControllerOptions) {
    if (!options.channel) {
      throw new Error("Panel channel is required");
    }
    this.channel = options.channel;
    this.view = options.view;
    this.inspectController = options.inspectController;
    this.readClipboard = options.readClipboard;
    this.sendCommand = options.sendCommand;
    this.subscribeWindowState = options.subscribeWindowState;
  }

  public async initialize(): Promise<void> {
    if (this.disposed || this.initialized) {
      return;
    }
    this.initialized = true;
    this.removeViewBindings = this.view.bind({
      onPaste: () => this.pasteAndLink(),
      onLink: () => this.link(this.view.readLinkCode()),
      onChangeIde: () => this.changeIde(),
      onUnlink: () => this.unlink(),
      onInspectChanged: (enabled) => this.setInspectEnabled(enabled),
      onLinkCodeChanged: () => {
        this.errorText = undefined;
        this.render();
      },
    });
    this.removeStateSubscription = this.subscribeWindowState((message) =>
      this.handleWindowState(message),
    );
    this.render();
  }

  public async handleTransportDisconnect(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.operationGeneration += 1;
    this.pendingLinkGeneration = undefined;
    this.busy = false;
    this.changingIde = false;
    this.inspectController.handleTransportDisconnect();
    if (this.hasLinkIntent) {
      this.state = "offline";
    }
    this.render();
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.operationGeneration += 1;
    this.pendingLinkGeneration = undefined;
    this.view.writeLinkCode("");
    this.removeStateSubscription?.();
    this.removeStateSubscription = undefined;
    this.removeViewBindings?.();
    this.removeViewBindings = undefined;
    try {
      await this.inspectController.disable();
    } catch {
      this.inspectController.handleTransportDisconnect();
    }
  }

  private async pasteAndLink(): Promise<void> {
    if (this.disposed || this.busy) {
      return;
    }
    const generation = ++this.operationGeneration;
    this.errorText = undefined;
    this.render();
    let clipboard: string;
    try {
      clipboard = await this.readClipboard();
    } catch {
      if (!this.isCurrent(generation)) {
        return;
      }
      this.state = "error";
      this.errorText = "Paste the seven-digit code manually";
      this.render();
      return;
    }
    if (!this.isCurrent(generation)) {
      return;
    }
    await this.link(clipboard);
  }

  private async link(rawCode: string): Promise<void> {
    if (this.disposed || this.busy) {
      return;
    }
    let code: string;
    try {
      code = parseLinkCode(rawCode.trim()).value;
    } catch {
      this.state = "error";
      this.errorText = "Enter a valid seven-digit code";
      this.render();
      return;
    }

    const generation = ++this.operationGeneration;
    this.pendingLinkGeneration = generation;
    await this.disableInspect();
    if (!this.isCurrent(generation)) {
      return;
    }
    if (this.pendingLinkGeneration === generation) {
      this.view.writeLinkCode(code);
    }
    this.changingIde = false;
    this.hasLinkIntent = true;
    this.busy = true;
    this.state = "linking";
    this.errorText = undefined;
    this.render();
    await this.runCommand(
      {
        type: "browser2ide.linkWindow",
        channel: this.channel,
        code,
      },
      generation,
    );
  }

  private async changeIde(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const generation = ++this.operationGeneration;
    this.pendingLinkGeneration = undefined;
    this.busy = false;
    await this.disableInspect();
    if (!this.isCurrent(generation)) {
      return;
    }
    this.changingIde = true;
    this.errorText = undefined;
    this.view.writeLinkCode("");
    this.render();
  }

  private async unlink(): Promise<void> {
    if (this.disposed || this.busy) {
      return;
    }
    const generation = ++this.operationGeneration;
    this.pendingLinkGeneration = undefined;
    await this.disableInspect();
    if (!this.isCurrent(generation)) {
      return;
    }
    this.busy = true;
    this.errorText = undefined;
    this.render();
    await this.runCommand(
      {
        type: "browser2ide.unlinkWindow",
        channel: this.channel,
      },
      generation,
    );
    if (!this.isCurrent(generation) || this.busy) {
      return;
    }
    if (this.state === "notLinked") {
      this.changingIde = false;
      this.view.writeLinkCode("");
      this.render();
    }
  }

  private async runCommand(
    command: PanelCommand,
    generation: number,
  ): Promise<void> {
    let response: unknown;
    try {
      response = await this.sendCommand(command);
    } catch {
      if (!this.isCurrent(generation)) {
        return;
      }
      if (command.type === "browser2ide.linkWindow") {
        this.pendingLinkGeneration = undefined;
      }
      this.busy = false;
      this.state = "error";
      this.errorText = "Browser2IDE background is unavailable";
      this.render();
      return;
    }
    if (!this.isCurrent(generation)) {
      return;
    }
    if (command.type === "browser2ide.linkWindow") {
      this.pendingLinkGeneration = undefined;
    }
    this.busy = false;
    const result = parseCommandResult(response);
    if (!result) {
      this.state = "error";
      this.errorText = "Browser2IDE background returned an invalid response";
    } else if (!result.ok) {
      if (
        command.type === "browser2ide.linkWindow" &&
        result.error !== "busy" &&
        result.error !== "stalePanel"
      ) {
        this.hasLinkIntent = false;
      }
      this.applyCommandError(result.error);
    } else if (command.type === "browser2ide.linkWindow") {
      this.view.writeLinkCode("");
    } else {
      this.state = "notLinked";
      this.hasLinkIntent = false;
      this.changingIde = false;
      this.view.writeLinkCode("");
    }
    this.render();
  }

  private async handleWindowState(message: unknown): Promise<void> {
    if (parseInspectPortInvalidated(message)) {
      if (!this.disposed) {
        this.inspectController.handleTransportDisconnect();
        this.errorText = undefined;
        this.render();
      }
      return;
    }
    const nextState = parseWindowState(message);
    if (!nextState || this.disposed) {
      return;
    }
    this.state = nextState;
    if (nextState === "notLinked") {
      this.hasLinkIntent = false;
    } else if (
      nextState === "linking" ||
      nextState === "connected" ||
      nextState === "reconnecting" ||
      nextState === "offline"
    ) {
      this.hasLinkIntent = true;
    }
    if (nextState === "connected") {
      if (this.pendingLinkGeneration === this.operationGeneration) {
        this.pendingLinkGeneration = undefined;
        this.view.writeLinkCode("");
      }
      this.errorText = undefined;
    } else {
      await this.disableInspect();
    }
    this.render();
  }

  private async setInspectEnabled(enabled: boolean): Promise<void> {
    if (
      this.disposed ||
      (enabled &&
        (this.state !== "connected" || this.busy || this.changingIde))
    ) {
      this.render();
      return;
    }
    try {
      await this.inspectController.setEnabled(enabled);
      this.errorText = undefined;
    } catch {
      this.inspectController.handleTransportDisconnect();
      this.errorText = "Inspect connection is unavailable";
    }
    this.render();
  }

  private async disableInspect(): Promise<void> {
    try {
      await this.inspectController.disable();
    } catch {
      this.inspectController.handleTransportDisconnect();
    }
  }

  private applyCommandError(error: PanelCommandError): void {
    switch (error) {
      case "rateLimited":
        this.state = "rateLimited";
        this.errorText = "Too many attempts. Try again in one minute.";
        return;
      case "invalidCode":
        this.state = "error";
        this.errorText = "Enter a valid seven-digit code";
        return;
      case "stalePanel":
        this.state = "error";
        this.errorText = "Reopen Browser2IDE DevTools and try again";
        return;
      case "busy":
        this.state = "error";
        this.errorText = "Another Browser2IDE action is still running";
        return;
      case "error":
        this.state = "error";
        this.errorText = "Browser2IDE could not complete the action";
    }
  }

  private render(): void {
    if (this.disposed) {
      return;
    }
    const showLinkControls =
      this.changingIde ||
      this.state === "notLinked" ||
      this.state === "rateLimited" ||
      this.state === "error";
    const validCode = validNormalizedCode(this.view.readLinkCode());
    const inspectDisabled =
      this.busy || this.changingIde || this.state !== "connected";
    this.view.render({
      state: this.state,
      statusLabel: statusLabels[this.state],
      errorText: this.errorText,
      showLinkControls,
      showConnectedControls: this.hasLinkIntent,
      linkInputDisabled: this.busy,
      linkButtonDisabled: this.busy || !validCode,
      pasteButtonDisabled: this.busy,
      changeButtonDisabled: this.busy,
      unlinkButtonDisabled: this.busy || this.state === "notLinked",
      inspectDisabled,
      inspectChecked: !inspectDisabled && this.inspectController.enabled,
    });
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && this.operationGeneration === generation;
  }
}

function validNormalizedCode(value: string): boolean {
  try {
    parseLinkCode(value.trim());
    return true;
  } catch {
    return false;
  }
}

function parseWindowState(value: unknown): PanelOperationalState | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["type", "state"]) ||
    value.type !== "browser2ide.windowState"
  ) {
    return undefined;
  }
  switch (value.state) {
    case "notLinked":
    case "linking":
    case "reconnecting":
    case "offline":
    case "rateLimited":
    case "error":
      return value.state;
    case "linked":
      return "connected";
    default:
      return undefined;
  }
}

function parseCommandResult(value: unknown): PanelCommandResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.ok === true && hasOnlyKeys(value, ["ok"])) {
    return { ok: true };
  }
  if (
    value.ok !== false ||
    !hasOnlyKeys(value, ["ok", "error"]) ||
    !isCommandError(value.error)
  ) {
    return undefined;
  }
  return { ok: false, error: value.error };
}

function isCommandError(value: unknown): value is PanelCommandError {
  return (
    value === "invalidCode" ||
    value === "stalePanel" ||
    value === "busy" ||
    value === "rateLimited" ||
    value === "error"
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => keys.includes(key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
