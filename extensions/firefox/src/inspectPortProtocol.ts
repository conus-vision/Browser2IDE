export const INSPECT_PORT_NAME = "browser2ide.inspect";

export interface InspectPortRequest {
  readonly type: "browser2ide.inspect.setEnabled";
  readonly requestId: string;
  readonly tabId: number;
  readonly enabled: boolean;
}

export type InspectPortResult =
  | {
      readonly type: "browser2ide.inspect.result";
      readonly requestId: string;
      readonly ok: true;
    }
  | {
      readonly type: "browser2ide.inspect.result";
      readonly requestId: string;
      readonly ok: false;
      readonly error: string;
    };

export interface InspectPortEvent<T> {
  addListener(listener: T): void;
  removeListener(listener: T): void;
}

export interface BackgroundInspectPort {
  readonly name: string;
  readonly onMessage: InspectPortEvent<(message: unknown) => void>;
  readonly onDisconnect: InspectPortEvent<() => void>;
  postMessage(message: unknown): void;
}

export interface PanelInspectPort extends BackgroundInspectPort {
  disconnect(): void;
}

export function parseInspectPortRequest(
  value: unknown,
): InspectPortRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return value.type === "browser2ide.inspect.setEnabled" &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    Number.isInteger(value.tabId) &&
    Number(value.tabId) >= 0 &&
    typeof value.enabled === "boolean"
    ? {
        type: value.type,
        requestId: value.requestId,
        tabId: Number(value.tabId),
        enabled: value.enabled,
      }
    : undefined;
}

export function parseInspectPortResult(
  value: unknown,
): InspectPortResult | undefined {
  if (
    !isRecord(value) ||
    value.type !== "browser2ide.inspect.result" ||
    typeof value.requestId !== "string" ||
    typeof value.ok !== "boolean"
  ) {
    return undefined;
  }
  if (value.ok) {
    return {
      type: value.type,
      requestId: value.requestId,
      ok: true,
    };
  }
  return typeof value.error === "string"
    ? {
        type: value.type,
        requestId: value.requestId,
        ok: false,
        error: value.error,
      }
    : undefined;
}

export function parseInspectControllerCommand(value: unknown):
  | {
      readonly type: "enableInspectMode" | "disableInspectMode";
      readonly tabId: number;
    }
  | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return (value.type === "enableInspectMode" ||
    value.type === "disableInspectMode") &&
    Number.isInteger(value.tabId) &&
    Number(value.tabId) >= 0
    ? { type: value.type, tabId: Number(value.tabId) }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
