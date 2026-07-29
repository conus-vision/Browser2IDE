import {
  parseInspectControllerCommand,
  parseInspectPortResult,
  type InspectPortRequest,
  type PanelInspectPort,
} from "./inspectPortProtocol.js";

export class PanelInspectTransport {
  private readonly pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(reason: unknown): void;
    }
  >();
  private nextRequestId = 1;
  private disconnected = false;

  public constructor(private readonly port: PanelInspectPort) {
    this.port.onMessage.addListener(this.handleMessage);
    this.port.onDisconnect.addListener(this.handleDisconnect);
  }

  public send(message: unknown): Promise<unknown> {
    if (this.disconnected) {
      return Promise.reject(new Error("Inspect connection is closed"));
    }
    const command = parseInspectControllerCommand(message);
    if (!command) {
      return Promise.reject(new Error("Invalid inspect mode command"));
    }

    const requestId = String(this.nextRequestId);
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try {
        this.port.postMessage({
          type: "browser2ide.inspect.setEnabled",
          requestId,
          tabId: command.tabId,
          enabled: command.type === "enableInspectMode",
        } satisfies InspectPortRequest);
      } catch {
        this.pending.delete(requestId);
        reject(new Error("Inspect connection is closed"));
      }
    });
  }

  public dispose(): void {
    if (this.disconnected) {
      return;
    }
    this.close();
    try {
      this.port.disconnect();
    } catch {
      // The browser may already have closed the port.
    }
  }

  private readonly handleMessage = (message: unknown): void => {
    const result = parseInspectPortResult(message);
    if (!result) {
      return;
    }
    const pending = this.pending.get(result.requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(result.requestId);
    if (result.ok) {
      pending.resolve({ ok: true });
    } else {
      pending.reject(new Error(result.error));
    }
  };

  private readonly handleDisconnect = (): void => {
    this.close();
  };

  private close(): void {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    this.port.onMessage.removeListener(this.handleMessage);
    this.port.onDisconnect.removeListener(this.handleDisconnect);
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Inspect connection is closed"));
    }
    this.pending.clear();
  }
}
