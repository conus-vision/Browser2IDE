import { randomUUID } from "node:crypto";
import {
  Browser2IdeMessageSchema,
  PROTOCOL_VERSION,
} from "@browser2ide/protocol";
import {
  sendConnectionSafely,
  terminateConnectionSafely,
  type ClientRegistry,
} from "./clientRegistry.js";

const HEARTBEAT_INTERVAL_MS = 15_000;

export interface Heartbeat {
  stop(): void;
}

export function startHeartbeat(
  registry: ClientRegistry,
  intervalMs = HEARTBEAT_INTERVAL_MS,
): Heartbeat {
  const interval = setInterval(() => {
    for (const client of registry.all()) {
      if (client.missedPongs >= 2) {
        terminateConnectionSafely(client.connection);
        registry.remove(client.id);
        continue;
      }

      registry.markPingSent(client.id);
      const ping = Browser2IdeMessageSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        type: "ping",
        messageId: randomUUID(),
        sentAt: new Date().toISOString(),
        metadata: {},
      });
      sendConnectionSafely(client.connection, JSON.stringify(ping));
    }
  }, intervalMs);

  return {
    stop() {
      clearInterval(interval);
    },
  };
}
