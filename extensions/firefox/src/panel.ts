import browser from "webextension-polyfill";
import type { InspectPayload } from "./bridgeClient.js";
import {
  BrowserBridgeClient,
  InspectPublisher,
  type BrowserConnectionState,
  type BrowserCredentials,
} from "./bridgeClient.js";
import {
  loadPanelSettings,
  resetPairing,
  savePanelSettings,
  type PanelSettings,
  type PanelStorage,
} from "./panelState.js";
import { PanelInspectController } from "./panelInspectController.js";

const bridgeUrlInput = required<HTMLInputElement>("bridge-url");
const pairingCodeInput = required<HTMLInputElement>("pairing-code");
const sessionIdInput = required<HTMLInputElement>("session-id");
const pairButton = required<HTMLButtonElement>("pair-button");
const connectButton = required<HTMLButtonElement>("connect-button");
const inspectToggle = required<HTMLInputElement>("inspect-mode");
const connectionStatus = required<HTMLOutputElement>("connection-status");
const selectedSummary = required<HTMLOutputElement>("selected-summary");
const channel = new URLSearchParams(location.search).get("channel") ?? "";
const sourceId = `firefox-${globalThis.crypto.randomUUID()}`;
const storage: PanelStorage = {
  get: async (keys) => browser.storage.local.get(keys),
  set: async (values) => browser.storage.local.set(values),
  remove: async (keys) => browser.storage.local.remove(keys),
};

let settings: PanelSettings;
let inspectedTabId: number | undefined;
let client: BrowserBridgeClient | undefined;
let connected = false;
const inspectController = new PanelInspectController((message) =>
  browser.runtime.sendMessage(message),
);

const publisher = new InspectPublisher({
  send: (payload) => {
    client?.sendInspect(payload);
  },
});

void initialize().catch(showError);

async function initialize(): Promise<void> {
  settings = await loadPanelSettings(storage);
  bridgeUrlInput.value = settings.bridgeUrl;
  sessionIdInput.value = settings.sessionId;
  pairButton.disabled = false;
  connectButton.disabled = false;
  updatePairButton();
  updateControls();
  browser.runtime.onMessage.addListener(handleRuntimeMessage);
  await browser.runtime.sendMessage({
    type: "browser2ide.panelReady",
    channel,
  });
}

pairButton.addEventListener("click", () => {
  void pairOrReset().catch(showError);
});

connectButton.addEventListener("click", () => {
  void connectOrDisconnect().catch(showError);
});

inspectToggle.addEventListener("change", () => {
  void setInspectMode(inspectToggle.checked).catch((error) => {
    inspectToggle.checked = false;
    showError(error);
  });
});

window.addEventListener("unload", () => {
  void inspectController.disable();
  publisher.dispose();
  client?.disconnect();
  browser.runtime.onMessage.removeListener(handleRuntimeMessage);
});

async function pairOrReset(): Promise<void> {
  if (settings.authToken) {
    await disableInspectMode();
    client?.disconnect();
    client = undefined;
    connected = false;
    await resetPairing(storage);
    settings = { ...settings, authToken: undefined };
    pairingCodeInput.value = "";
    updatePairButton();
    updateConnectionState("disconnected");
    return;
  }

  const pairingCode = pairingCodeInput.value.trim();
  if (!/^\d{6}$/.test(pairingCode)) {
    throw new Error("Enter the six-digit pairing code");
  }
  settings = currentSettings();
  await savePanelSettings(storage, settings);
  client?.disconnect();
  client = createClient(settings.bridgeUrl);
  pairingCodeInput.value = "";
  client.pair(pairingCode);
}

async function connectOrDisconnect(): Promise<void> {
  if (connected) {
    await disableInspectMode();
    client?.disconnect();
    connected = false;
    updateConnectionState("disconnected");
    return;
  }
  settings = currentSettings(settings.authToken);
  if (!settings.authToken) {
    throw new Error("Pair this browser before connecting");
  }
  await savePanelSettings(storage, settings);
  client?.disconnect();
  client = createClient(settings.bridgeUrl);
  client.connect({
    sessionId: settings.sessionId,
    authToken: settings.authToken,
  });
}

function createClient(url: string): BrowserBridgeClient {
  return new BrowserBridgeClient({
    url,
    sourceId,
    onCredentials: (credentials) => {
      void storeCredentials(credentials).catch(showError);
    },
    onStateChanged: updateConnectionState,
    onError: showError,
  });
}

async function storeCredentials(
  credentials: BrowserCredentials,
): Promise<void> {
  settings = {
    bridgeUrl: bridgeUrlInput.value.trim(),
    sessionId: credentials.sessionId,
    authToken: credentials.authToken,
  };
  sessionIdInput.value = credentials.sessionId;
  await savePanelSettings(storage, settings);
  updatePairButton();
}

function updateConnectionState(state: BrowserConnectionState): void {
  publisher.reset();
  connected = state === "connected";
  if (!connected && inspectController.enabled) {
    void disableInspectMode().catch(showError);
  }
  connectionStatus.value = stateLabel(state);
  connectionStatus.dataset.state = state;
  connectButton.textContent = connected ? "Disconnect" : "Connect";
  updateControls();
}

function updatePairButton(): void {
  pairButton.textContent = settings.authToken ? "Reset pairing" : "Pair";
}

function updateControls(): void {
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
    selectedSummary.value = `${payload.subject.selector ?? "element"} | ${payload.facts.length} facts | ${inaccessible} inaccessible`;
    publisher.publish({
      subject: payload.subject,
      facts: payload.facts,
      context: payload.context,
      metadata: payload.metadata,
    });
  }
}

function currentSettings(authToken?: string): PanelSettings {
  const bridgeUrl = bridgeUrlInput.value.trim();
  if (!/^wss?:\/\//.test(bridgeUrl)) {
    throw new Error("Bridge URL must use ws:// or wss://");
  }
  const sessionId = sessionIdInput.value.trim();
  if (!sessionId) {
    throw new Error("Session is required");
  }
  return { bridgeUrl, sessionId, authToken };
}

function isInspectPayload(value: unknown): value is InspectPayload & {
  inaccessibleStylesheets?: unknown[];
} {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isRecord(value.subject) &&
    Array.isArray(value.facts) &&
    isRecord(value.context) &&
    isRecord(value.metadata)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function stateLabel(state: BrowserConnectionState): string {
  return {
    disconnected: "Disconnected",
    connecting: "Connecting",
    pairing: "Pairing",
    connected: "Connected",
    error: "Error",
  }[state];
}

function showError(error: unknown): void {
  connectionStatus.value = error instanceof Error ? error.message : String(error);
  connectionStatus.dataset.state = "error";
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing panel element: ${id}`);
  }
  return element as T;
}
