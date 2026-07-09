import { describe, expect, it } from "vitest";
import { ClientRegistry } from "../src/clientRegistry.js";
import { routeMessage } from "../src/router.js";

function client(role: "browser" | "ide" | "simulator", sessionId: string) {
  const sent: unknown[] = [];
  return {
    sent,
    connection: {
      send: (payload: string) => sent.push(JSON.parse(payload)),
      terminate: () => undefined,
    },
    source: { role, id: `${role}-source`, metadata: {} },
    sessionId,
  };
}

const inspectMessage = {
  protocolVersion: 1,
  type: "inspect",
  messageId: "inspect-1",
  sessionId: "session-1",
  source: { role: "browser", id: "browser-source", metadata: {} },
  subject: { selector: "#submit", metadata: {} },
  facts: [],
  context: { url: "http://localhost:3000", metadata: {} },
  metadata: {},
} as const;

const referencesMessage = {
  protocolVersion: 1,
  type: "references",
  messageId: "references-1",
  subject: { selector: "#submit", metadata: {} },
  references: [],
  metadata: {},
} as const;

const commandMessage = {
  protocolVersion: 1,
  type: "command",
  messageId: "command-1",
  command: "highlightElement",
  arguments: { selector: "#submit", metadata: {} },
  metadata: {},
} as const;

describe("bridge router and registry", () => {
  it("stores clients by protocol sessionId and role", () => {
    const registry = new ClientRegistry();
    const ide = registry.add(client("ide", "session-1"));
    registry.add(client("browser", "session-1"));
    registry.add(client("ide", "session-2"));

    expect(registry.findBySessionAndRole("session-1", "ide")).toEqual([ide]);
    expect(registry.findBySessionAndRole("session-1", "browser")).toHaveLength(1);
    expect(registry.findBySessionAndRole("session-2", "ide")).toHaveLength(1);

    registry.remove(ide.id);
    expect(registry.findBySessionAndRole("session-1", "ide")).toEqual([]);
  });

  it("routes inspect from browser and simulator clients to IDE clients in the same session", () => {
    const registry = new ClientRegistry();
    const ideSame = client("ide", "session-1");
    const ideOther = client("ide", "session-2");
    const browser = registry.add(client("browser", "session-1"));
    registry.add(ideSame);
    registry.add(ideOther);

    routeMessage(registry, browser, inspectMessage);

    expect(ideSame.sent).toEqual([inspectMessage]);
    expect(ideOther.sent).toEqual([]);
  });

  it("routes command from IDE clients to browser clients in the same session", () => {
    const registry = new ClientRegistry();
    const ide = registry.add(client("ide", "session-1"));
    const browserSame = client("browser", "session-1");
    const browserOther = client("browser", "session-2");
    registry.add(browserSame);
    registry.add(browserOther);

    routeMessage(registry, ide, commandMessage);

    expect(browserSame.sent).toEqual([commandMessage]);
    expect(browserOther.sent).toEqual([]);
  });

  it("routes references to browser clients in the same session", () => {
    const registry = new ClientRegistry();
    const ide = registry.add(client("ide", "session-1"));
    const browser = client("browser", "session-1");
    registry.add(browser);

    routeMessage(registry, ide, referencesMessage);

    expect(browser.sent).toEqual([referencesMessage]);
  });
});
