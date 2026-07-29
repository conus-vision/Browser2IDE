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
  readonly bridgeInstanceId: string;
  readonly authToken: string;
}

export type BrowserConnectionState =
  | "disconnected"
  | "connecting"
  | "linking"
  | "reconnecting"
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
  readonly setTimeout?: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly onCredentials?: (credentials: BrowserCredentials) => void;
  readonly onStateChanged?: (state: BrowserConnectionState) => void;
  readonly onError?: (error: Error) => void;
}

export type InspectPayload = Pick<
  InspectMessage,
  "targets" | "context" | "metadata"
>;

type ConnectionIntent =
  | { readonly kind: "link"; readonly pin: string }
  | { readonly kind: "credentials"; readonly credentials: BrowserCredentials };

export class BrowserBridgeClient {
  private readonly socketFactory: (url: string) => BrowserSocket;
  private readonly messageId: () => string;
  private readonly now: () => Date;
  private readonly scheduleTimer: NonNullable<BrowserBridgeClientOptions["setTimeout"]>;
  private readonly cancelTimer: NonNullable<BrowserBridgeClientOptions["clearTimeout"]>;
  private socket: BrowserSocket | undefined;
  private connectionIntent: ConnectionIntent | undefined;
  private credentials: BrowserCredentials | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 0;
  private reconnectEnabled = false;
  private authenticated = false;
  private pendingCredentialNotification = false;
  private state: BrowserConnectionState = "disconnected";

  public constructor(private readonly options: BrowserBridgeClientOptions) {
    this.socketFactory =
      options.socketFactory ?? ((url) => new WebSocket(url) as BrowserSocket);
    this.messageId = options.messageId ?? defaultMessageId;
    this.now = options.now ?? (() => new Date());
    this.scheduleTimer = options.setTimeout ?? setTimeout;
    this.cancelTimer = options.clearTimeout ?? clearTimeout;
  }

  public link(pin: string): void {
    this.start({ kind: "link", pin });
  }

  public connect(credentials: BrowserCredentials): void {
    this.start({ kind: "credentials", credentials });
  }

  public disconnect(): void {
    this.reconnectEnabled = false;
    if (this.reconnectTimer !== undefined) {
      this.cancelTimer(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      this.detach(socket);
      socket.close();
    }
    this.connectionIntent = undefined;
    this.credentials = undefined;
    this.authenticated = false;
    this.pendingCredentialNotification = false;
    this.reconnectAttempts = 0;
    this.setState("disconnected");
  }

  public unlink(): void {
    if (this.socket && this.credentials && this.authenticated) {
      this.send({
        protocolVersion: PROTOCOL_VERSION,
        type: "unlink",
        messageId: this.messageId(),
        sessionId: this.credentials.sessionId,
        metadata: {},
      });
    }
    this.disconnect();
  }

  public sendInspect(payload: InspectPayload): boolean {
    if (
      !this.socket ||
      !this.credentials ||
      !this.authenticated ||
      this.state !== "connected"
    ) {
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

  private start(intent: ConnectionIntent): void {
    this.reconnectEnabled = false;
    if (this.reconnectTimer !== undefined) {
      this.cancelTimer(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const previousSocket = this.socket;
    this.socket = undefined;
    if (previousSocket) {
      this.detach(previousSocket);
      previousSocket.close();
    }
    this.connectionIntent = intent;
    this.credentials = intent.kind === "credentials" ? intent.credentials : undefined;
    this.authenticated = false;
    this.pendingCredentialNotification = false;
    this.reconnectAttempts = 0;
    this.reconnectEnabled = true;
    this.openSocket(false);
  }

  private openSocket(reconnecting: boolean): void {
    const intent = this.connectionIntent;
    if (!intent || !this.reconnectEnabled) {
      return;
    }
    this.setState(reconnecting ? "reconnecting" : "connecting");
    const socket = this.socketFactory(this.options.url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) {
        return;
      }
      socket.onopen = null;
      if (intent.kind === "link") {
        this.setState("linking");
        this.send({
          protocolVersion: PROTOCOL_VERSION,
          type: "linkRequest",
          messageId: this.messageId(),
          pin: intent.pin,
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
    socket.onerror = () => {
      if (this.socket === socket) {
        this.fail(new Error("WebSocket connection failed"));
      }
    };
    socket.onclose = () => this.handleClose(socket);
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
    if (message.type === "linkAccepted") {
      if (this.connectionIntent?.kind !== "link") {
        this.stopForProtocolError(
          new BrowserProtocolError(
            "protocol.invalidMessage",
            "Bridge sent an unexpected link response",
          ),
        );
        return;
      }
      const credentials: BrowserCredentials = {
        sessionId: message.sessionId,
        bridgeInstanceId: message.bridgeInstanceId,
        authToken: message.authToken,
      };
      this.credentials = credentials;
      this.connectionIntent = { kind: "credentials", credentials };
      this.pendingCredentialNotification = true;
      this.sendHello();
      return;
    }
    if (message.type === "authenticated") {
      if (
        !this.credentials ||
        message.sessionId !== this.credentials.sessionId ||
        message.bridgeInstanceId !== this.credentials.bridgeInstanceId
      ) {
        this.stopForProtocolError(
          new BrowserProtocolError(
            "protocol.invalidMessage",
            "Bridge authenticated an unexpected identity",
          ),
        );
        return;
      }
      this.authenticated = true;
      this.reconnectAttempts = 0;
      if (this.pendingCredentialNotification) {
        this.pendingCredentialNotification = false;
        this.options.onCredentials?.(this.credentials);
      }
      this.setState("connected");
      return;
    }
    if (message.type === "ping" && this.authenticated) {
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
      if (
        message.code === "auth.instanceChanged" ||
        message.code === "auth.tokenRejected"
      ) {
        this.stopForProtocolError(sanitizedAuthError(message.code));
        return;
      }
      if (this.connectionIntent?.kind === "link") {
        this.stopForProtocolError(sanitizedLinkError(message.code));
        return;
      }
      if (isNonfatalServerError(message.code)) {
        this.report(new BrowserProtocolError(message.code, message.message));
        return;
      }
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
      bridgeInstanceId: this.credentials.bridgeInstanceId,
      source: {
        role: "browser",
        id: this.options.sourceId,
        metadata: {},
      },
      capabilities: ["inspect", "link"],
      metadata: {},
    });
  }

  private send(message: unknown): void {
    this.socket?.send(JSON.stringify(Browser2IdeMessageSchema.parse(message)));
  }

  private fail(error: Error): void {
    this.setState("error");
    this.report(error);
  }

  private report(error: Error): void {
    this.options.onError?.(error);
  }

  private stopForProtocolError(error: BrowserProtocolError): void {
    this.reconnectEnabled = false;
    if (this.reconnectTimer !== undefined) {
      this.cancelTimer(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.connectionIntent = undefined;
    this.credentials = undefined;
    this.authenticated = false;
    this.pendingCredentialNotification = false;

    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      this.detach(socket);
      socket.close();
    }
    this.fail(error);
  }

  private handleClose(socket: BrowserSocket): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = undefined;
    this.authenticated = false;
    this.detach(socket);
    if (!this.reconnectEnabled || !this.connectionIntent) {
      this.setState("disconnected");
      return;
    }

    this.setState("reconnecting");
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempts, 5_000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = this.scheduleTimer(() => {
      this.reconnectTimer = undefined;
      this.openSocket(true);
    }, delay);
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

function sanitizedAuthError(
  code: "auth.instanceChanged" | "auth.tokenRejected",
): BrowserProtocolError {
  const message =
    code === "auth.instanceChanged"
      ? "Bridge instance changed; link again"
      : "Bridge authentication was rejected; link again";
  return new BrowserProtocolError(code, message);
}

function sanitizedLinkError(code: ProtocolErrorCode): BrowserProtocolError {
  const message =
    code === "link.rateLimited"
      ? "Link request rate limited"
      : "Link request rejected";
  return new BrowserProtocolError(code, message);
}

function isNonfatalServerError(code: ProtocolErrorCode): boolean {
  return code === "bridge.noIdeClient";
}
