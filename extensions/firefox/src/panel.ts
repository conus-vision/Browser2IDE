import browser from "webextension-polyfill";
import type { InspectPayload } from "./bridgeClient.js";
import {
  BrowserBridgeClient,
  BrowserProtocolError,
  InspectPublisher,
  type BrowserConnectionState,
  type BrowserCredentials,
} from "./bridgeClient.js";
import {
  loadPanelSettings,
  parseLinkCode,
  resetPanelSettings,
  savePanelSettings,
  type PanelSettings,
  type PanelStorage,
} from "./panelState.js";
import { PanelDiagnostics } from "./panelDiagnostics.js";
import { PanelInspectController } from "./panelInspectController.js";

const linkForm = required<HTMLFormElement>("link-form");
const linkCodeInput = required<HTMLInputElement>("link-code");
const linkButton = required<HTMLButtonElement>("link-button");
const unlinkButton = required<HTMLButtonElement>("unlink-button");
const inspectToggle = required<HTMLInputElement>("inspect-mode");
const connectionStatus = required<HTMLOutputElement>("connection-status");
const selectedSummary = required<HTMLOutputElement>("selected-summary");
const linkStatus = required<HTMLOutputElement>("link-status");
const linkedEndpoint = required<HTMLOutputElement>("linked-endpoint");
const linkedSession = required<HTMLOutputElement>("linked-session");
const bridgeInstance = required<HTMLOutputElement>("bridge-instance");
const linkDetailElements = document.querySelectorAll<HTMLElement>(
  "[data-link-detail]",
);
const lastMessage = required<HTMLOutputElement>("last-message");
const lastError = required<HTMLOutputElement>("last-error");
const matchedFacts = required<HTMLOutputElement>("matched-facts");
const inaccessibleStylesheets = required<HTMLOutputElement>(
  "inaccessible-stylesheets",
);
const channel = new URLSearchParams(location.search).get("channel") ?? "";
const sourceId = `firefox-${globalThis.crypto.randomUUID()}`;
const storage: PanelStorage = {
  get: async (keys) => browser.storage.local.get(keys),
  set: async (values) => browser.storage.local.set(values),
  remove: async (keys) => browser.storage.local.remove(keys),
};

type ConnectionIntent = "none" | "link" | "reconnect";

let settings: PanelSettings | undefined;
let inspectedTabId: number | undefined;
let client: BrowserBridgeClient | undefined;
let connected = false;
let connectionIntent: ConnectionIntent = "none";
let storageQueue = Promise.resolve();
const diagnostics = new PanelDiagnostics();
const inspectController = new PanelInspectController((message) =>
  browser.runtime.sendMessage(message),
);

const publisher = new InspectPublisher({
  send: (payload) => {
    if (client?.sendInspect(payload)) {
      diagnostics.recordMessageSent();
      renderDiagnostics();
    }
  },
});

linkForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void linkToBridge().catch(showError);
});

linkCodeInput.addEventListener("input", updateControls);

unlinkButton.addEventListener("click", () => {
  void unlinkFromBridge().catch(showError);
});

inspectToggle.addEventListener("change", () => {
  void setInspectMode(inspectToggle.checked).catch((error) => {
    inspectToggle.checked = false;
    showError(error);
  });
});

window.addEventListener("unload", dispose);

void initialize().catch(showError);

async function initialize(): Promise<void> {
  settings = await loadPanelSettings(storage);
  if (settings) {
    diagnostics.setLink(toLinkDetails(settings));
  }
  renderDiagnostics();
  updateControls();

  browser.runtime.onMessage.addListener(handleRuntimeMessage);
  await browser.runtime.sendMessage({
    type: "browser2ide.panelReady",
    channel,
  });

  if (settings === undefined) {
    renderConnectionStatus();
    return;
  }

  connectionIntent = "reconnect";
  client = createClient(settings.bridgeUrl);
  client.connect(settings.credentials);
}

async function linkToBridge(): Promise<void> {
  const parsed = parseLinkCode(linkCodeInput.value);
  const disableError = await tryDisableInspectMode();
  const previousClient = client;
  client = undefined;
  previousClient?.unlink();
  connected = false;
  connectionIntent = "none";
  settings = undefined;
  publisher.reset();
  diagnostics.reset();
  selectedSummary.value = "None";
  renderDiagnostics();
  updateControls();
  await queueStorage(() => resetPanelSettings(storage));

  if (disableError) {
    throw disableError;
  }

  connectionIntent = "link";
  client = createClient(parsed.url);
  client.link(parsed.pin);
  updateControls();
}

async function unlinkFromBridge(): Promise<void> {
  const disableError = await tryDisableInspectMode();
  client?.unlink();
  client = undefined;
  connected = false;
  connectionIntent = "none";
  settings = undefined;
  publisher.reset();
  diagnostics.reset();
  selectedSummary.value = "None";
  linkCodeInput.value = "";
  renderDiagnostics();
  updateControls();
  await queueStorage(() => resetPanelSettings(storage));

  if (disableError) {
    throw disableError;
  }
}

function createClient(url: string): BrowserBridgeClient {
  let createdClient: BrowserBridgeClient;
  createdClient = new BrowserBridgeClient({
    url,
    sourceId,
    onCredentials: (credentials) => {
      if (client !== createdClient) {
        return;
      }
      void storeCredentials(credentials, url, createdClient).catch(showError);
    },
    onStateChanged: (state) => {
      if (client === createdClient) {
        updateConnectionState(state);
      }
    },
    onError: (error) => {
      if (client === createdClient) {
        handleClientError(error, createdClient);
      }
    },
  });
  return createdClient;
}

async function storeCredentials(
  credentials: BrowserCredentials,
  bridgeUrl: string,
  owner: BrowserBridgeClient,
): Promise<void> {
  const nextSettings: PanelSettings = { bridgeUrl, credentials };
  await queueStorage(() => savePanelSettings(storage, nextSettings));
  if (client !== owner) {
    return;
  }

  settings = nextSettings;
  connectionIntent = "reconnect";
  linkCodeInput.value = "";
  diagnostics.setLink(toLinkDetails(nextSettings));
  renderDiagnostics();
  updateControls();
}

function handleClientError(
  error: Error,
  owner: BrowserBridgeClient,
): void {
  if (
    error instanceof BrowserProtocolError &&
    (error.code === "auth.instanceChanged" ||
      error.code === "auth.tokenRejected")
  ) {
    void invalidateSavedLink(error, owner).catch(showError);
    return;
  }

  if (
    error instanceof BrowserProtocolError &&
    error.code.startsWith("link.")
  ) {
    client = undefined;
    owner.disconnect();
    connected = false;
    connectionIntent = "none";
  }
  showError(error);
  updateControls();
}

async function invalidateSavedLink(
  error: BrowserProtocolError,
  owner: BrowserBridgeClient,
): Promise<void> {
  if (client !== owner) {
    return;
  }

  const disableError = await tryDisableInspectMode();
  client = undefined;
  owner.disconnect();
  connected = false;
  connectionIntent = "none";
  settings = undefined;
  publisher.reset();
  diagnostics.reset();
  diagnostics.recordError({ code: error.code, message: error.message });
  selectedSummary.value = "None";
  renderDiagnostics();
  updateControls();
  await queueStorage(() => resetPanelSettings(storage));

  if (disableError) {
    throw disableError;
  }
}

function updateConnectionState(state: BrowserConnectionState): void {
  diagnostics.setConnectionState(state);
  publisher.reset();
  connected = state === "connected";
  if (!connected && inspectController.enabled) {
    void disableInspectMode().catch(showError);
  }
  renderDiagnostics();
  updateControls();
}

function updateControls(): void {
  const hasLinkCode = linkCodeInput.value.replace(/[\s-]/g, "").length > 0;
  linkButton.disabled = !hasLinkCode;
  unlinkButton.disabled = client === undefined && settings === undefined;
  inspectToggle.disabled = !connected || inspectedTabId === undefined;
  inspectToggle.checked = inspectController.enabled;
}

async function setInspectMode(enabled: boolean): Promise<void> {
  await inspectController.setEnabled(enabled);
  inspectToggle.checked = inspectController.enabled;
}

async function disableInspectMode(): Promise<void> {
  await inspectController.disable();
  inspectToggle.checked = false;
}

async function tryDisableInspectMode(): Promise<unknown | undefined> {
  try {
    await disableInspectMode();
    return undefined;
  } catch (error) {
    inspectToggle.checked = false;
    return error;
  }
}

function handleRuntimeMessage(message: unknown): void {
  if (!isRecord(message)) {
    return;
  }
  if (
    message.type === "browser2ide.inspectedTab" &&
    message.channel === channel &&
    typeof message.tabId === "number"
  ) {
    inspectedTabId = message.tabId;
    inspectController.setTabId(message.tabId);
    updateControls();
    return;
  }
  if (
    message.type === "browser2ide.selection" &&
    message.tabId === inspectedTabId &&
    isInspectPayload(message.payload)
  ) {
    const payload = message.payload;
    const inaccessible = Array.isArray(payload.inaccessibleStylesheets)
      ? payload.inaccessibleStylesheets.length
      : 0;
    const selected = payload.targets.find(
      (target) => target.role === "selected",
    );
    const facts = payload.targets.flatMap((target) => target.facts);
    diagnostics.recordSelection(payload.targets, inaccessible);
    if (inaccessible > 0) {
      diagnostics.recordError({
        code: "browser.stylesheetInaccessible",
        message: `${inaccessible} stylesheet${inaccessible === 1 ? " is" : "s are"} inaccessible`,
      });
    }
    renderDiagnostics();
    selectedSummary.value = `${selected?.subject.selector ?? "element"} | ${facts.length} facts | ${inaccessible} inaccessible`;
    publisher.publish({
      targets: payload.targets,
      context: payload.context,
      metadata: payload.metadata,
    });
  }
}

function isInspectPayload(value: unknown): value is InspectPayload & {
  inaccessibleStylesheets?: unknown[];
} {
  if (!isRecord(value)) {
    return false;
  }
  return (
    Array.isArray(value.targets) &&
    value.targets.every(
      (target) =>
        isRecord(target) &&
        (target.role === "selected" || target.role === "parent") &&
        isRecord(target.subject) &&
        Array.isArray(target.facts) &&
        isRecord(target.metadata),
    ) &&
    isRecord(value.context) &&
    isRecord(value.metadata)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function showError(error: unknown): void {
  diagnostics.recordError({
    ...(error instanceof BrowserProtocolError ? { code: error.code } : {}),
    message: error instanceof Error ? error.message : "Unexpected panel error",
  });
  if (diagnostics.snapshot().connectionState === "disconnected") {
    diagnostics.setConnectionState("error");
  }
  renderDiagnostics();
}

function renderDiagnostics(): void {
  const snapshot = diagnostics.snapshot();
  const presentation = connectionPresentation(
    snapshot.connectionState,
    snapshot.lastError?.code,
  );
  connectionStatus.value = presentation.label;
  connectionStatus.dataset.state = presentation.state;
  linkStatus.value = presentation.label;

  const hasLinkDetails = snapshot.link !== undefined;
  for (const element of linkDetailElements) {
    element.hidden = !hasLinkDetails;
  }
  linkedEndpoint.value = snapshot.link?.url ?? "None";
  linkedSession.value = snapshot.link?.sessionId ?? "None";
  bridgeInstance.value = snapshot.link?.bridgeInstanceId ?? "None";
  lastMessage.value = snapshot.lastMessageSentAt?.toISOString() ?? "None";
  lastError.value = snapshot.lastError
    ? `${snapshot.lastError.code ? `${snapshot.lastError.code}: ` : ""}${snapshot.lastError.message}`
    : "None";
  matchedFacts.value = String(snapshot.matchedCssFactCount);
  inaccessibleStylesheets.value = String(
    snapshot.inaccessibleStylesheetCount,
  );
}

function renderConnectionStatus(): void {
  renderDiagnostics();
}

function connectionPresentation(
  state: BrowserConnectionState,
  errorCode: string | undefined,
): { readonly label: string; readonly state: string } {
  if (state === "error" && errorCode === "link.rateLimited") {
    return { label: "Rate-limited", state: "rate-limited" };
  }
  if (state === "connected") {
    return { label: "Linked", state: "connected" };
  }
  if (state === "linking") {
    return { label: "Linking", state: "linking" };
  }
  if (state === "reconnecting") {
    return { label: "Reconnecting", state: "reconnecting" };
  }
  if (state === "connecting") {
    return connectionIntent === "link"
      ? { label: "Linking", state: "linking" }
      : { label: "Reconnecting", state: "reconnecting" };
  }
  if (state === "error") {
    return { label: "Error", state: "error" };
  }
  return settings
    ? { label: "Offline", state: "offline" }
    : { label: "Not linked", state: "not-linked" };
}

function toLinkDetails(value: PanelSettings) {
  return {
    url: value.bridgeUrl,
    sessionId: value.credentials.sessionId,
    bridgeInstanceId: value.credentials.bridgeInstanceId,
  };
}

function queueStorage(operation: () => Promise<void>): Promise<void> {
  const queued = storageQueue.then(operation);
  storageQueue = queued.catch(() => undefined);
  return queued;
}

function dispose(): void {
  browser.runtime.onMessage.removeListener(handleRuntimeMessage);
  void inspectController.disable().catch(() => undefined);
  inspectToggle.checked = false;
  publisher.dispose();
  const activeClient = client;
  client = undefined;
  activeClient?.disconnect();
  connected = false;
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing panel element: ${id}`);
  }
  return element as T;
}
