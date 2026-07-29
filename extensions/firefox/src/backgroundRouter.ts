export interface BackgroundRouterApi {
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
