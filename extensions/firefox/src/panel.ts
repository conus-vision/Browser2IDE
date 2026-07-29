import browser from "webextension-polyfill";
import {
  PanelController,
  PanelInspectController,
  PanelInspectTransport,
  createDevtoolsPanelPortName,
  createPanelIcons,
  type PanelActions,
  type PanelView,
  type PanelViewModel,
} from "@browser2ide/browser-extension-core";

const channel = new URLSearchParams(location.search).get("channel") ?? "";
const stateListeners = new Set<
  (message: unknown) => void | Promise<void>
>();
let disposed = false;
let recovery: Promise<void> | undefined;
let controller: PanelController;
let inspectTransport: PanelInspectTransport;

function ensurePanelPort(): Promise<void> {
  if (disposed) {
    return Promise.resolve();
  }
  if (recovery) {
    return recovery;
  }

  const pending = browser.runtime
    .sendMessage({
      type: "browser2ide.panelReady",
      channel,
    })
    .then(() => {
      if (!disposed) {
        inspectTransport.connect();
      }
    })
    .catch(() => controller.handleTransportDisconnect());
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
  if (disposed) {
    return;
  }
  disposed = true;
  stateListeners.clear();
  void controller.dispose();
  inspectTransport.dispose();
  window.removeEventListener("unload", dispose);
}

class FirefoxPanelView implements PanelView {
  private readonly linkControls = required<HTMLElement>("link-controls");
  private readonly linkForm = required<HTMLFormElement>("link-form");
  private readonly linkCode = required<HTMLInputElement>("link-code");
  private readonly pasteButton = required<HTMLButtonElement>("paste-button");
  private readonly linkButton = required<HTMLButtonElement>("link-button");
  private readonly connectedControls = required<HTMLElement>(
    "connected-controls",
  );
  private readonly changeButton = required<HTMLButtonElement>("change-button");
  private readonly unlinkButton = required<HTMLButtonElement>("unlink-button");
  private readonly inspectToggle = required<HTMLInputElement>("inspect-mode");
  private readonly connectionStatus = required<HTMLOutputElement>(
    "connection-status",
  );
  private readonly panelError = required<HTMLOutputElement>("panel-error");

  public bind(actions: PanelActions): () => void {
    const submit = (event: Event): void => {
      event.preventDefault();
      run(actions.onLink);
    };
    const paste = (): void => run(actions.onPaste);
    const change = (): void => run(actions.onChangeIde);
    const unlink = (): void => run(actions.onUnlink);
    const inspect = (): void =>
      run(() => actions.onInspectChanged(this.inspectToggle.checked));
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
}

function run(action: () => void | Promise<void>): void {
  void Promise.resolve(action()).catch(() => undefined);
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing panel element: ${id}`);
  }
  return element as T;
}

function startPanel(): void {
  const view = new FirefoxPanelView();
  inspectTransport = new PanelInspectTransport(
    () =>
      browser.runtime.connect({
        name: createDevtoolsPanelPortName(channel),
      }),
    () => {
      void controller.handleTransportDisconnect();
      void ensurePanelPort();
    },
    (message) => {
      for (const listener of [...stateListeners]) {
        void Promise.resolve(listener(message)).catch(() => undefined);
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
    readClipboard: () => navigator.clipboard.readText(),
    sendCommand: (message) => browser.runtime.sendMessage(message),
    subscribeWindowState: (listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  });

  createPanelIcons();
  void controller.initialize().then(ensurePanelPort);
  window.addEventListener("unload", dispose);
}

startPanel();
