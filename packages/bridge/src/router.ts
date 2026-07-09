import { randomUUID } from "node:crypto";
import {
  Browser2IdeMessageSchema,
  type Browser2IdeMessage,
  type ClientRole,
  type ErrorMessage,
} from "@browser2ide/protocol";
import type { ClientRegistry, RegisteredClient } from "./clientRegistry.js";

export function routeMessage(
  registry: ClientRegistry,
  sender: RegisteredClient,
  message: Browser2IdeMessage,
): void {
  switch (message.type) {
    case "inspect":
      if (sender.source.role === "browser" || sender.source.role === "simulator") {
        sendToRoles(registry, sender.sessionId, ["ide"], message);
      }
      return;
    case "references":
      sendToRoles(registry, sender.sessionId, ["browser"], message);
      return;
    case "command":
      if (sender.source.role === "ide") {
        sendToRoles(registry, sender.sessionId, ["browser"], message);
      }
      return;
    case "error":
      sendMessage(sender, message);
      return;
    default:
      return;
  }
}

export function sendError(
  client: RegisteredClient,
  code: string,
  message: string,
  fatal = false,
): void {
  sendMessage(client, {
    protocolVersion: 1,
    type: "error",
    messageId: randomUUID(),
    code,
    message,
    details: { fatal },
    metadata: {},
  });
}

export function sendMessage(
  client: RegisteredClient,
  message: Browser2IdeMessage | ErrorMessage,
): void {
  const parsed = Browser2IdeMessageSchema.parse(message);
  client.connection.send(JSON.stringify(parsed));
}

function sendToRoles(
  registry: ClientRegistry,
  sessionId: string,
  roles: ClientRole[],
  message: Browser2IdeMessage,
): void {
  for (const role of roles) {
    for (const client of registry.findBySessionAndRole(sessionId, role)) {
      sendMessage(client, message);
    }
  }
}
