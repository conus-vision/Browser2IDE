export interface PanelStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface PanelSettings {
  readonly bridgeUrl: string;
  readonly sessionId: string;
  readonly authToken?: string;
}

const BRIDGE_URL_KEY = "browser2ideBridgeUrl";
const SESSION_ID_KEY = "browser2ideSessionId";
const AUTH_TOKEN_KEY = "browser2ideAuthToken";
const KEYS = [BRIDGE_URL_KEY, SESSION_ID_KEY, AUTH_TOKEN_KEY];

export async function loadPanelSettings(
  storage: PanelStorage,
): Promise<PanelSettings> {
  const stored = await storage.get(KEYS);
  return {
    bridgeUrl: stringValue(stored[BRIDGE_URL_KEY]) ?? "ws://127.0.0.1:48735",
    sessionId: stringValue(stored[SESSION_ID_KEY]) ?? "default",
    authToken: stringValue(stored[AUTH_TOKEN_KEY]),
  };
}

export async function savePanelSettings(
  storage: PanelStorage,
  settings: PanelSettings,
): Promise<void> {
  const values: Record<string, unknown> = {
    [BRIDGE_URL_KEY]: settings.bridgeUrl,
    [SESSION_ID_KEY]: settings.sessionId,
  };
  if (settings.authToken) {
    values[AUTH_TOKEN_KEY] = settings.authToken;
  }
  await storage.set(values);
  if (!settings.authToken) {
    await storage.remove([AUTH_TOKEN_KEY]);
  }
}

export async function resetPairing(storage: PanelStorage): Promise<void> {
  await storage.remove([AUTH_TOKEN_KEY]);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
