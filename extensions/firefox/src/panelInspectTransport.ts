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
  private connection: PortConnection | undefined;
  private disposed = false;

  public constructor(
    private readonly createPort: () => PanelInspectPort,
    private readonly onUnexpectedDisconnect: () => void = () => {},
  ) {}

  public send(message: unknown): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error("Inspect connection is closed"));
    }
    const command = parseInspectControllerCommand(message);
    if (!command) {
      return Promise.reject(new Error("Invalid inspect mode command"));
    }
    let connection: PortConnection;
    try {
      connection = this.connection ?? this.openConnection();
    } catch {
      return Promise.reject(new Error("Inspect connection is closed"));
    }

    const requestId = String(this.nextRequestId);
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try {
        connection.port.postMessage({
          type: "browser2ide.inspect.setEnabled",
          requestId,
          tabId: command.tabId,
          enabled: command.type === "enableInspectMode",
        } satisfies InspectPortRequest);
      } catch {
        this.closeConnection(connection, true);
      }
    });
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const connection = this.connection;
    if (!connection) {
      this.rejectPending();
      return;
    }
    this.closeConnection(connection, false);
    try {
      connection.port.disconnect();
    } catch {
      // The browser may already have closed the port.
    }
  }

  private openConnection(): PortConnection {
    const port = this.createPort();
    const connection: PortConnection = {
      port,
      onMessage: (message) => this.handleMessage(connection, message),
      onDisconnect: () => this.handleDisconnect(connection),
    };
    this.connection = connection;
    port.onMessage.addListener(connection.onMessage);
    port.onDisconnect.addListener(connection.onDisconnect);
    return connection;
  }

  private handleMessage(
    connection: PortConnection,
    message: unknown,
  ): void {
    if (this.connection !== connection) {
      return;
    }
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
  }

  private handleDisconnect(connection: PortConnection): void {
    this.closeConnection(connection, true);
  }

  private closeConnection(
    connection: PortConnection,
    unexpected: boolean,
  ): void {
    if (this.connection !== connection) {
      return;
    }
    this.connection = undefined;
    connection.port.onMessage.removeListener(connection.onMessage);
    connection.port.onDisconnect.removeListener(connection.onDisconnect);
    this.rejectPending();
    if (unexpected && !this.disposed) {
      this.onUnexpectedDisconnect();
    }
  }

  private rejectPending(): void {
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Inspect connection is closed"));
    }
    this.pending.clear();
  }
}

interface PortConnection {
  readonly port: PanelInspectPort;
  readonly onMessage: (message: unknown) => void;
  readonly onDisconnect: () => void;
}
