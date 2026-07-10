export interface BackgroundRouterApi {
  executeScript(details: {
    target: { tabId: number };
    files: string[];
  }): Promise<unknown>;
  sendTabMessage(tabId: number, message: unknown): Promise<unknown>;
  sendRuntimeMessage(message: unknown): Promise<unknown>;
}

export interface BackgroundSender {
  readonly tabId?: number;
}

export function createBackgroundRouter(api: BackgroundRouterApi) {
  return async (
    message: unknown,
    sender: BackgroundSender,
  ): Promise<{ ok: true } | undefined> => {
    if (!isRecord(message) || typeof message.type !== "string") {
      return undefined;
    }
    if (
      (message.type === "enableInspectMode" ||
        message.type === "disableInspectMode") &&
      typeof message.tabId === "number"
    ) {
      if (message.type === "enableInspectMode") {
        await api.executeScript({
          target: { tabId: message.tabId },
          files: ["dist/contentScript.js"],
        });
      }
      await api.sendTabMessage(message.tabId, { type: message.type });
      return { ok: true };
    }
    if (message.type === "elementSelected" && sender.tabId !== undefined) {
      await api.sendRuntimeMessage({
        type: "browser2ide.selection",
        tabId: sender.tabId,
        payload: message.payload,
      });
      return { ok: true };
    }
    return undefined;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
