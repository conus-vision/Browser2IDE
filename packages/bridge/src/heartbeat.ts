import { randomUUID } from "node:crypto";
import { Browser2IdeMessageSchema } from "@browser2ide/protocol";
import type { ClientRegistry } from "./clientRegistry.js";

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
      if (client.missedPongs >= 1) {
        client.connection.terminate();
        registry.remove(client.id);
        continue;
      }

      registry.markPingSent(client.id);
      const ping = Browser2IdeMessageSchema.parse({
        protocolVersion: 1,
        type: "ping",
        messageId: randomUUID(),
        sentAt: new Date().toISOString(),
        metadata: {},
      });
      client.connection.send(JSON.stringify(ping));
    }
  }, intervalMs);

  return {
    stop() {
      clearInterval(interval);
    },
  };
}
