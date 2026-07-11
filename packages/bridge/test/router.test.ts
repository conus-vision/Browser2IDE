import { PROTOCOL_VERSION } from "@browser2ide/protocol";
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
    authToken: `${role}-${sessionId}-token`,
  };
}

const inspectMessage = {
  protocolVersion: PROTOCOL_VERSION,
  type: "inspect",
  messageId: "inspect-1",
  sessionId: "session-1",
  source: { role: "browser", id: "browser-source", metadata: {} },
  targets: [
    {
      role: "selected",
      depth: 0,
      subject: { selector: "#submit", metadata: {} },
      facts: [],
      metadata: {},
    },
  ],
  context: { url: "http://localhost:3000", metadata: {} },
  metadata: {},
} as const;

const simulatorInspectMessage = {
  ...inspectMessage,
  messageId: "inspect-simulator-1",
  source: { role: "simulator", id: "simulator-source", metadata: {} },
} as const;

const referencesMessage = {
  protocolVersion: PROTOCOL_VERSION,
  type: "references",
  messageId: "references-1",
  subject: { selector: "#submit", metadata: {} },
  references: [],
  metadata: {},
} as const;

const commandMessage = {
  protocolVersion: PROTOCOL_VERSION,
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
    expect(registry.countByRole("browser")).toBe(1);
    expect(registry.countByRole("ide")).toBe(2);

    registry.remove(ide.id);
    expect(registry.findBySessionAndRole("session-1", "ide")).toEqual([]);

    registry.clear();
    expect(registry.all()).toEqual([]);
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

    const simulator = registry.add(client("simulator", "session-1"));
    routeMessage(registry, simulator, simulatorInspectMessage);

    expect(ideSame.sent).toEqual([inspectMessage, simulatorInspectMessage]);
    expect(ideOther.sent).toEqual([]);
  });

  it("reports when an inspect message has no IDE recipient", () => {
    const registry = new ClientRegistry();
    const browserConnection = client("browser", "session-1");
    const browser = registry.add(browserConnection);

    routeMessage(registry, browser, inspectMessage);

    expect(browserConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "bridge.noIdeClient",
      }),
    ]);
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

  it("reports when an IDE message has no browser recipient", () => {
    const registry = new ClientRegistry();
    const ideConnection = client("ide", "session-1");
    const ide = registry.add(ideConnection);

    routeMessage(registry, ide, commandMessage);

    expect(ideConnection.sent).toEqual([
      expect.objectContaining({
        type: "error",
        code: "bridge.noBrowserClient",
      }),
    ]);
  });

  it("routes references to browser clients in the same session", () => {
    const registry = new ClientRegistry();
    const ide = registry.add(client("ide", "session-1"));
    const browser = client("browser", "session-1");
    registry.add(browser);

    routeMessage(registry, ide, referencesMessage);

    expect(browser.sent).toEqual([referencesMessage]);
  });

  it("does not route references from browser or simulator clients", () => {
    const registry = new ClientRegistry();
    const browserSender = registry.add(client("browser", "session-1"));
    const simulatorSender = registry.add(client("simulator", "session-1"));
    const browserRecipient = client("browser", "session-1");
    registry.add(browserRecipient);

    routeMessage(registry, browserSender, referencesMessage);
    routeMessage(registry, simulatorSender, referencesMessage);

    expect(browserRecipient.sent).toEqual([]);
  });

  it("contains recipient send failures", () => {
    const registry = new ClientRegistry();
    const browser = registry.add(client("browser", "session-1"));
    const ide = client("ide", "session-1");
    ide.connection.send = () => {
      throw new Error("send failed");
    };
    registry.add(ide);

    expect(() => routeMessage(registry, browser, inspectMessage)).not.toThrow();
  });
});
