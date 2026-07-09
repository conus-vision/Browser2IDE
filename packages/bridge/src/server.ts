import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import {
  Browser2IdeMessageSchema,
  PairAcceptedMessageSchema,
  type Browser2IdeMessage,
} from "@browser2ide/protocol";
import { ClientRegistry, type RegisteredClient } from "./clientRegistry.js";
import { startHeartbeat, type Heartbeat } from "./heartbeat.js";
import { PairingStore, type PairingCode } from "./pairing.js";
import { routeMessage } from "./router.js";

export interface BridgeServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly sessionId?: string;
  readonly pairingStore?: PairingStore;
  readonly registry?: ClientRegistry;
}

export interface BridgeServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  createPairingCode(sessionId?: string): PairingCode;
  getUrl(): string;
  readonly registry: ClientRegistry;
  readonly pairingStore: PairingStore;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 48_735;

export function createBridgeServer(
  options: BridgeServerOptions = {},
): BridgeServer {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const defaultSessionId = options.sessionId ?? "default";
  const registry = options.registry ?? new ClientRegistry();
  const pairingStore = options.pairingStore ?? new PairingStore();
  let server: WebSocketServer | undefined;
  let heartbeat: Heartbeat | undefined;

  return {
    registry,
    pairingStore,
    async start() {
      if (server) {
        return;
      }

      server = new WebSocketServer({ host, port });
      server.on("connection", (socket) => handleConnection(socket, registry, pairingStore));
      heartbeat = startHeartbeat(registry);

      await new Promise<void>((resolve, reject) => {
        server?.once("listening", resolve);
        server?.once("error", reject);
      });
    },
    async stop() {
      heartbeat?.stop();
      heartbeat = undefined;

      await new Promise<void>((resolve, reject) => {
        if (!server) {
          resolve();
          return;
        }

        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          server = undefined;
          resolve();
        });
      });
    },
    createPairingCode(sessionId = defaultSessionId) {
      return pairingStore.createPairingCode(sessionId);
    },
    getUrl() {
      const address = server?.address();
      const resolvedPort =
        typeof address === "object" && address ? (address as AddressInfo).port : port;
      return `ws://${host}:${resolvedPort}`;
    },
  };
}

function handleConnection(
  socket: WebSocket,
  registry: ClientRegistry,
  pairingStore: PairingStore,
): void {
  let registered: RegisteredClient | undefined;

  socket.on("message", (data) => {
    const raw = data.toString();
    let message: Browser2IdeMessage;

    try {
      message = Browser2IdeMessageSchema.parse(JSON.parse(raw));
    } catch {
      sendSocketError(socket, "INVALID_MESSAGE", "Message does not match protocol", true);
      socket.close();
      return;
    }

    if (message.type === "pairRequest") {
      const accepted = pairingStore.acceptPairRequest(message.pairingCode);
      if (!accepted) {
        sendSocketError(socket, "PAIRING_REJECTED", "Pairing code is invalid or expired");
        return;
      }

      const response = PairAcceptedMessageSchema.parse({
        protocolVersion: 1,
        type: "pairAccepted",
        messageId: randomUUID(),
        sessionId: accepted.sessionId,
        authToken: accepted.authToken.value,
        expiresAt: accepted.authToken.expiresAt.toISOString(),
        metadata: {},
      });
      socket.send(JSON.stringify(response));
      return;
    }

    if (!registered) {
      if (message.type !== "hello") {
        sendSocketError(socket, "UNAUTHORIZED", "Client must authenticate with hello", true);
        socket.close();
        return;
      }

      if (!pairingStore.validateToken(message.sessionId, message.authToken)) {
        sendSocketError(socket, "UNAUTHORIZED", "Invalid session token", true);
        socket.close();
        return;
      }

      registered = registry.add({
        connection: socket,
        source: message.source,
        sessionId: message.sessionId,
      });
      return;
    }

    if (message.type === "pong") {
      registry.markAlive(registered.id);
      return;
    }

    routeMessage(registry, registered, message);
  });

  socket.on("close", () => {
    if (registered) {
      registry.remove(registered.id);
    }
  });
}

function sendSocketError(
  socket: WebSocket,
  code: string,
  message: string,
  fatal = false,
): void {
  const error = Browser2IdeMessageSchema.parse({
    protocolVersion: 1,
    type: "error",
    messageId: randomUUID(),
    code,
    message,
    details: { fatal },
    metadata: {},
  });
  socket.send(JSON.stringify(error));
}
