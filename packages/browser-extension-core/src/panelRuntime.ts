import {
  createPanelIcons,
  PanelController,
  type PanelActions,
  type PanelView,
  type PanelViewModel,
} from "./panelController.js";
import { PanelInspectController } from "./panelInspectController.js";
import { PanelInspectTransport } from "./panelInspectTransport.js";
import {
  createDevtoolsPanelPortName,
  isValidDevtoolsChannel,
  type PanelInspectPort,
} from "./inspectPortProtocol.js";

export interface PanelDocument {
  getElementById(id: string): unknown;
}

export interface PanelRuntimeOptions {
  readonly locationSearch: string;
  readonly document: PanelDocument;
  readonly connectRuntimePort: (name: string) => PanelInspectPort;
  readonly sendRuntimeMessage: (message: unknown) => Promise<unknown>;
  readonly readClipboard: () => Promise<string>;
  readonly subscribeUnload: (listener: () => void) => () => void;
  readonly initializeIcons?: () => void;
  readonly onError?: (error: unknown) => void;
}

export interface PanelRuntime {
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  dispose(): void;
}

export function startPanelRuntime(options: PanelRuntimeOptions): PanelRuntime {
  const channel = new URLSearchParams(options.locationSearch).get("channel") ?? "";
  if (!isValidDevtoolsChannel(channel)) {
    throw new Error("Invalid DevTools panel channel");
  }
  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Diagnostics cannot break panel ownership.
    }
  };
  const view = new DomPanelView(options.document, reportError);
  const stateListeners = new Set<(message: unknown) => void | Promise<void>>();
  let disposed = false;
  let recovery: Promise<void> | undefined;
  let removeUnload: (() => void) | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closePromise: Promise<void> | undefined;
  let controller: PanelController;

  const inspectTransport = new PanelInspectTransport(
    () => options.connectRuntimePort(createDevtoolsPanelPortName(channel)),
    () => {
      void controller.handleTransportDisconnect().catch(reportError);
      void ensurePanelPort();
    },
    (message) => {
      for (const listener of [...stateListeners]) {
        void Promise.resolve(listener(message)).catch(reportError);
      }
    },
  );
  const inspectController = new PanelInspectController((message) =>
    inspectTransport.send(message),
  );
  controller = new PanelController({
    channel,
    view,
    inspectController,
    readClipboard: options.readClipboard,
    sendCommand: options.sendRuntimeMessage,
    subscribeWindowState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  });

  function ensurePanelPort(): Promise<void> {
    if (disposed) {
      return Promise.resolve();
    }
    if (recovery) {
      return recovery;
    }
    const pending = options
      .sendRuntimeMessage({
        type: "browser2ide.panelReady",
        channel,
      })
      .then(() => {
        if (!disposed) {
          inspectTransport.connect();
        }
      })
      .catch(async (error) => {
        reportError(error);
        await controller.handleTransportDisconnect();
      });
    let tracked: Promise<void>;
    tracked = pending.finally(() => {
      if (recovery === tracked) {
        recovery = undefined;
      }
    });
    recovery = tracked;
    return tracked;
  }

  function dispose(): void {
    if (closePromise) {
      return;
    }
    disposed = true;
    const remove = removeUnload;
    removeUnload = undefined;
    remove?.();
    stateListeners.clear();
    closePromise = controller
      .dispose()
      .catch(reportError)
      .finally(resolveClosed);
    inspectTransport.dispose();
  }

  const unloadSubscription = options.subscribeUnload(dispose);
  if (disposed) {
    unloadSubscription();
  } else {
    removeUnload = unloadSubscription;
  }

  const ready = Promise.resolve()
    .then(() => {
      try {
        (options.initializeIcons ?? createPanelIcons)();
      } catch (error) {
        reportError(error);
      }
    })
    .then(() => controller.initialize())
    .then(ensurePanelPort)
    .catch(reportError);

  return { ready, closed, dispose };
}

class DomPanelView implements PanelView {
  private readonly linkControls: PanelElement;
  private readonly linkForm: PanelElement;
  private readonly linkCode: PanelElement;
  private readonly pasteButton: PanelElement;
  private readonly linkButton: PanelElement;
  private readonly connectedControls: PanelElement;
  private readonly changeButton: PanelElement;
  private readonly unlinkButton: PanelElement;
  private readonly inspectToggle: PanelElement;
  private readonly connectionStatus: PanelElement;
  private readonly panelError: PanelElement;

  public constructor(
    document: PanelDocument,
    private readonly onError: (error: unknown) => void,
  ) {
    this.linkControls = required(document, "link-controls");
    this.linkForm = required(document, "link-form");
    this.linkCode = required(document, "link-code");
    this.pasteButton = required(document, "paste-button");
    this.linkButton = required(document, "link-button");
    this.connectedControls = required(document, "connected-controls");
    this.changeButton = required(document, "change-button");
    this.unlinkButton = required(document, "unlink-button");
    this.inspectToggle = required(document, "inspect-mode");
    this.connectionStatus = required(document, "connection-status");
    this.panelError = required(document, "panel-error");
  }

  public bind(actions: PanelActions): () => void {
    const submit = (event: Event): void => {
      event.preventDefault();
      this.run(actions.onLink);
    };
    const paste = (): void => this.run(actions.onPaste);
    const change = (): void => this.run(actions.onChangeIde);
    const unlink = (): void => this.run(actions.onUnlink);
    const inspect = (): void =>
      this.run(() => actions.onInspectChanged(this.inspectToggle.checked));
    const input = (): void => actions.onLinkCodeChanged(this.linkCode.value);

    this.linkForm.addEventListener("submit", submit);
    this.pasteButton.addEventListener("click", paste);
    this.changeButton.addEventListener("click", change);
    this.unlinkButton.addEventListener("click", unlink);
    this.inspectToggle.addEventListener("change", inspect);
    this.linkCode.addEventListener("input", input);

    return () => {
      this.linkForm.removeEventListener("submit", submit);
      this.pasteButton.removeEventListener("click", paste);
      this.changeButton.removeEventListener("click", change);
      this.unlinkButton.removeEventListener("click", unlink);
      this.inspectToggle.removeEventListener("change", inspect);
      this.linkCode.removeEventListener("input", input);
    };
  }

  public readLinkCode(): string {
    return this.linkCode.value;
  }

  public writeLinkCode(value: string): void {
    this.linkCode.value = value;
  }

  public render(model: PanelViewModel): void {
    this.connectionStatus.value = model.statusLabel;
    this.connectionStatus.dataset.state = model.state;
    this.linkControls.hidden = !model.showLinkControls;
    this.connectedControls.hidden = !model.showConnectedControls;
    this.linkCode.disabled = model.linkInputDisabled;
    this.pasteButton.disabled = model.pasteButtonDisabled;
    this.linkButton.disabled = model.linkButtonDisabled;
    this.changeButton.disabled = model.changeButtonDisabled;
    this.unlinkButton.disabled = model.unlinkButtonDisabled;
    this.inspectToggle.disabled = model.inspectDisabled;
    this.inspectToggle.checked = model.inspectChecked;
    this.panelError.value = model.errorText ?? "";
    this.panelError.hidden = model.errorText === undefined;
  }

  private run(action: () => void | Promise<void>): void {
    void Promise.resolve(action()).catch(this.onError);
  }
}

interface PanelElement {
  value: string;
  checked: boolean;
  disabled: boolean;
  hidden: boolean;
  readonly dataset: Record<string, string>;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

function required(document: PanelDocument, id: string): PanelElement {
  const element = document.getElementById(id);
  if (!element || typeof element !== "object") {
    throw new Error(`Missing panel element: ${id}`);
  }
  return element as PanelElement;
}
