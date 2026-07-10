import {
  Browser2IdeMessageSchema,
  PROTOCOL_VERSION,
  type InspectMessage,
  type ProtocolErrorCode,
} from "@browser2ide/protocol";

export class BrowserProtocolError extends Error {
  public readonly name = "BrowserProtocolError";

  public constructor(
    public readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface BrowserCredentials {
  readonly sessionId: string;
  readonly authToken: string;
}

export type BrowserConnectionState =
  | "disconnected"
  | "connecting"
  | "pairing"
  | "connected"
  | "error";

export interface BrowserSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(payload: string): void;
  close(): void;
}

export interface BrowserBridgeClientOptions {
  readonly url: string;
  readonly sourceId: string;
  readonly socketFactory?: (url: string) => BrowserSocket;
  readonly messageId?: () => string;
  readonly now?: () => Date;
  readonly onCredentials?: (credentials: BrowserCredentials) => void;
  readonly onStateChanged?: (state: BrowserConnectionState) => void;
  readonly onError?: (error: Error) => void;
}

export type InspectPayload = Pick<
  InspectMessage,
  "targets" | "context" | "metadata"
>;

type ConnectionIntent =
  | { readonly kind: "pair"; readonly pairingCode: string }
  | { readonly kind: "credentials"; readonly credentials: BrowserCredentials };

export class BrowserBridgeClient {
  private readonly socketFactory: (url: string) => BrowserSocket;
  private readonly messageId: () => string;
  private readonly now: () => Date;
  private socket: BrowserSocket | undefined;
  private credentials: BrowserCredentials | undefined;
  private state: BrowserConnectionState = "disconnected";

  public constructor(private readonly options: BrowserBridgeClientOptions) {
    this.socketFactory =
      options.socketFactory ?? ((url) => new WebSocket(url) as BrowserSocket);
    this.messageId = options.messageId ?? defaultMessageId;
    this.now = options.now ?? (() => new Date());
  }

  public pair(pairingCode: string): void {
    this.open({ kind: "pair", pairingCode });
  }

  public connect(credentials: BrowserCredentials): void {
    this.open({ kind: "credentials", credentials });
  }

  public disconnect(): void {
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      this.detach(socket);
      socket.close();
    }
    this.credentials = undefined;
    this.setState("disconnected");
  }

  public sendInspect(payload: InspectPayload): boolean {
    if (!this.socket || !this.credentials || this.state !== "connected") {
      return false;
    }
    this.send({
      protocolVersion: PROTOCOL_VERSION,
      type: "inspect",
      messageId: this.messageId(),
      sessionId: this.credentials.sessionId,
      source: {
        role: "browser",
        id: this.options.sourceId,
        metadata: {},
      },
      targets: payload.targets,
      context: payload.context,
      metadata: payload.metadata,
    });
    return true;
  }

  private open(intent: ConnectionIntent): void {
    if (this.socket) {
      this.disconnect();
    }
    this.setState("connecting");
    const socket = this.socketFactory(this.options.url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) {
        return;
      }
      socket.onopen = null;
      if (intent.kind === "pair") {
        this.setState("pairing");
        this.send({
          protocolVersion: PROTOCOL_VERSION,
          type: "pairRequest",
          messageId: this.messageId(),
          pairingCode: intent.pairingCode,
          source: {
            role: "browser",
            id: this.options.sourceId,
            metadata: {},
          },
          metadata: {},
        });
        return;
      }
      this.credentials = intent.credentials;
      this.sendHello();
    };
    socket.onmessage = (event) => this.handleMessage(socket, event.data);
    socket.onerror = () => this.fail(new Error("WebSocket connection failed"));
    socket.onclose = () => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = undefined;
      this.credentials = undefined;
      this.detach(socket);
      this.setState("disconnected");
    };
  }

  private handleMessage(socket: BrowserSocket, data: unknown): void {
    if (this.socket !== socket) {
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      this.fail(
        new BrowserProtocolError(
          "protocol.invalidMessage",
          "Bridge sent invalid JSON",
        ),
      );
      return;
    }
    const parsed = Browser2IdeMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.fail(
        new BrowserProtocolError(
          "protocol.invalidMessage",
          "Bridge sent an invalid protocol message",
        ),
      );
      return;
    }
    const message = parsed.data;
    if (message.type === "pairAccepted") {
      this.credentials = {
        sessionId: message.sessionId,
        authToken: message.authToken,
      };
      this.options.onCredentials?.(this.credentials);
      this.sendHello();
      return;
    }
    if (message.type === "ping") {
      this.send({
        protocolVersion: PROTOCOL_VERSION,
        type: "pong",
        messageId: this.messageId(),
        pingMessageId: message.messageId,
        sentAt: this.now().toISOString(),
        metadata: {},
      });
      return;
    }
    if (message.type === "error") {
      this.fail(new BrowserProtocolError(message.code, message.message));
    }
  }

  private sendHello(): void {
    if (!this.credentials) {
      return;
    }
    this.send({
      protocolVersion: PROTOCOL_VERSION,
      type: "hello",
      messageId: this.messageId(),
      sessionId: this.credentials.sessionId,
      authToken: this.credentials.authToken,
      source: {
        role: "browser",
        id: this.options.sourceId,
        metadata: {},
      },
      capabilities: ["inspect", "pairing"],
      metadata: {},
    });
    this.setState("connected");
  }

  private send(message: unknown): void {
    this.socket?.send(JSON.stringify(Browser2IdeMessageSchema.parse(message)));
  }

  private fail(error: Error): void {
    this.setState("error");
    this.options.onError?.(error);
  }

  private setState(state: BrowserConnectionState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.options.onStateChanged?.(state);
  }

  private detach(socket: BrowserSocket): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  }
}

export interface InspectPublisherOptions {
  readonly send: (payload: InspectPayload) => void;
  readonly setTimeout?: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class InspectPublisher {
  private readonly schedule: NonNullable<InspectPublisherOptions["setTimeout"]>;
  private readonly cancel: NonNullable<InspectPublisherOptions["clearTimeout"]>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastSentHash: string | undefined;
  private pending:
    | { readonly hash: string; readonly payload: InspectPayload }
    | undefined;

  public constructor(private readonly options: InspectPublisherOptions) {
    this.schedule = options.setTimeout ?? setTimeout;
    this.cancel = options.clearTimeout ?? clearTimeout;
  }

  public publish(payload: InspectPayload): void {
    const hash = JSON.stringify(payload);
    if (hash === this.lastSentHash) {
      this.pending = undefined;
      return;
    }
    if (hash === this.pending?.hash) {
      return;
    }
    if (this.timer === undefined) {
      this.sendNow(payload, hash);
      return;
    }
    this.pending = { hash, payload };
  }

  public dispose(): void {
    this.reset();
  }

  public reset(): void {
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
    this.pending = undefined;
    this.lastSentHash = undefined;
  }

  private sendNow(payload: InspectPayload, hash: string): void {
    this.options.send(payload);
    this.lastSentHash = hash;
    this.timer = this.schedule(() => {
      this.timer = undefined;
      const pending = this.pending;
      this.pending = undefined;
      if (pending) {
        this.sendNow(pending.payload, pending.hash);
      }
    }, 100);
  }
}

function defaultMessageId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
