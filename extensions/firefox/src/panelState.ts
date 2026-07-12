import type { BrowserCredentials } from "./bridgeClient.js";

export interface PanelStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface PanelSettings {
  readonly bridgeUrl: string;
  readonly credentials: BrowserCredentials;
}

export interface ParsedLinkCode {
  readonly code: string;
  readonly url: string;
  readonly pin: string;
}

const BRIDGE_URL_KEY = "browser2ideBridgeUrl";
const SESSION_ID_KEY = "browser2ideSessionId";
const BRIDGE_INSTANCE_ID_KEY = "browser2ideBridgeInstanceId";
const AUTH_TOKEN_KEY = "browser2ideAuthToken";
const KEYS = [
  BRIDGE_URL_KEY,
  SESSION_ID_KEY,
  BRIDGE_INSTANCE_ID_KEY,
  AUTH_TOKEN_KEY,
];

export function parseLinkCode(value: string): ParsedLinkCode {
  const code = value.replace(/[\s-]/g, "");
  if (!/^[0-9]{7}$/.test(code)) {
    throw new Error("Link code must contain seven digits");
  }

  const port = Number(code.slice(0, 5));
  if (port < 10_000 || port > 65_535) {
    throw new Error("Link code port must be between 10000 and 65535");
  }

  return {
    code,
    url: `ws://127.0.0.1:${port}`,
    pin: code.slice(5),
  };
}

export async function loadPanelSettings(
  storage: PanelStorage,
): Promise<PanelSettings | undefined> {
  const stored = await storage.get(KEYS);
  const bridgeUrl = stringValue(stored[BRIDGE_URL_KEY]);
  const sessionId = stringValue(stored[SESSION_ID_KEY]);
  const bridgeInstanceId = stringValue(stored[BRIDGE_INSTANCE_ID_KEY]);
  const authToken = stringValue(stored[AUTH_TOKEN_KEY]);

  if (bridgeUrl && sessionId && bridgeInstanceId && authToken) {
    return {
      bridgeUrl,
      credentials: { sessionId, bridgeInstanceId, authToken },
    };
  }

  if (KEYS.some((key) => stored[key] !== undefined)) {
    await resetPanelSettings(storage);
  }
  return undefined;
}

export async function savePanelSettings(
  storage: PanelStorage,
  settings: PanelSettings,
): Promise<void> {
  await storage.set({
    [BRIDGE_URL_KEY]: settings.bridgeUrl,
    [SESSION_ID_KEY]: settings.credentials.sessionId,
    [BRIDGE_INSTANCE_ID_KEY]: settings.credentials.bridgeInstanceId,
    [AUTH_TOKEN_KEY]: settings.credentials.authToken,
  });
}

export async function resetPanelSettings(
  storage: PanelStorage,
): Promise<void> {
  await storage.remove(KEYS);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
