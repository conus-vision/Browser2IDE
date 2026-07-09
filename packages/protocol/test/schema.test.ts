import { describe, expect, it } from "vitest";
import { parseMessage } from "../src/index.js";

const source = {
  role: "browser",
  id: "browser-tab-1",
  label: "Demo tab",
  url: "http://localhost:3000",
  metadata: {
    tabId: 12,
  },
};

const sourceLocation = {
  uri: "file:///workspace/src/App.tsx",
  line: 12,
  column: 3,
  endLine: 15,
  endColumn: 8,
  metadata: {
    loader: "vite",
  },
};

const reference = {
  kind: "component",
  relation: "renders",
  label: "App",
  source: sourceLocation,
  confidence: "sourcemap",
  status: "active",
  metadata: {
    exportName: "App",
  },
};

const runtimeFacts = [
  {
    type: "css-rule",
    selector: ".primary",
    property: "color",
    value: "red",
    source: sourceLocation,
    metadata: {},
  },
  {
    type: "dom-attribute",
    name: "aria-label",
    value: "Submit form",
    metadata: {},
  },
];

describe("Browser2IDE protocol schemas", () => {
  it.each([
    [
      "hello",
      {
        protocolVersion: 1,
        type: "hello",
        messageId: "msg-hello",
        source,
        capabilities: ["inspect", "references"],
        metadata: {
          userAgent: "Vitest",
        },
      },
    ],
    [
      "pairRequest",
      {
        protocolVersion: 1,
        type: "pairRequest",
        messageId: "msg-pair-request",
        pairingCode: "123456",
        source,
        metadata: {},
      },
    ],
    [
      "pairAccepted",
      {
        protocolVersion: 1,
        type: "pairAccepted",
        messageId: "msg-pair-accepted",
        sessionId: "session-1",
        authToken: "token-1",
        expiresAt: "2026-07-09T15:00:00.000Z",
        metadata: {},
      },
    ],
    [
      "inspect",
      {
        protocolVersion: 1,
        type: "inspect",
        messageId: "msg-inspect",
        sessionId: "session-1",
        source,
        subject: {
          selector: "#root > button",
          nodeId: "node-1",
          text: "Submit",
          attributes: [
            {
              name: "data-testid",
              value: "submit",
              metadata: {},
            },
          ],
          metadata: {},
        },
        facts: runtimeFacts,
        context: {
          url: "http://localhost:3000/form",
          frameId: "main",
          route: "/form",
          metadata: {
            viewport: "desktop",
          },
        },
        metadata: {},
      },
    ],
    [
      "references",
      {
        protocolVersion: 1,
        type: "references",
        messageId: "msg-references",
        subject: {
          selector: "#root > button",
          metadata: {},
        },
        references: [reference],
        metadata: {},
      },
    ],
    [
      "command",
      {
        protocolVersion: 1,
        type: "command",
        messageId: "msg-command",
        command: "openSource",
        arguments: {
          uri: "file:///workspace/src/App.tsx",
          line: 12,
        },
        metadata: {},
      },
    ],
    [
      "error",
      {
        protocolVersion: 1,
        type: "error",
        messageId: "msg-error",
        code: "UNMAPPED_SOURCE",
        message: "Could not map element to source",
        details: {
          selector: "#missing",
        },
        metadata: {},
      },
    ],
    [
      "ping",
      {
        protocolVersion: 1,
        type: "ping",
        messageId: "msg-ping",
        sentAt: "2026-07-09T14:00:00.000Z",
        metadata: {},
      },
    ],
    [
      "pong",
      {
        protocolVersion: 1,
        type: "pong",
        messageId: "msg-pong",
        pingMessageId: "msg-ping",
        sentAt: "2026-07-09T14:00:01.000Z",
        metadata: {},
      },
    ],
  ])("parses a valid %s message", (_name, message) => {
    expect(parseMessage(message)).toEqual(message);
  });

  it("rejects inspect messages with facts nested inside the subject", () => {
    expect(() =>
      parseMessage({
        protocolVersion: 1,
        type: "inspect",
        messageId: "msg-inspect-nested-facts",
        sessionId: "session-1",
        source,
        subject: {
          selector: "#root > button",
          facts: runtimeFacts,
          metadata: {},
        },
        facts: runtimeFacts,
        context: {
          url: "http://localhost:3000/form",
          metadata: {},
        },
        metadata: {},
      }),
    ).toThrow();
  });

  it("rejects unsupported protocol versions", () => {
    expect(() =>
      parseMessage({
        protocolVersion: 2,
        type: "ping",
        messageId: "msg-ping",
        sentAt: "2026-07-09T14:00:00.000Z",
        metadata: {},
      }),
    ).toThrow();
  });

  it("rejects messages with no type", () => {
    expect(() =>
      parseMessage({
        protocolVersion: 1,
        messageId: "msg-missing-type",
        metadata: {},
      }),
    ).toThrow();
  });

  it("rejects source locations with zero-based positions", () => {
    expect(() =>
      parseMessage({
        protocolVersion: 1,
        type: "references",
        messageId: "msg-bad-location",
        subject: {
          selector: "#root",
          metadata: {},
        },
        references: [
          {
            ...reference,
            source: {
              ...sourceLocation,
              line: 0,
            },
          },
        ],
        metadata: {},
      }),
    ).toThrow();
  });

  it("rejects unknown top-level fields while preserving metadata entries", () => {
    expect(() =>
      parseMessage({
        protocolVersion: 1,
        type: "ping",
        messageId: "msg-extra-top-level",
        sentAt: "2026-07-09T14:00:00.000Z",
        unexpected: true,
        metadata: {
          unexpected: true,
        },
      }),
    ).toThrow();

    const message = {
      protocolVersion: 1,
      type: "ping",
      messageId: "msg-extra-metadata",
      sentAt: "2026-07-09T14:00:00.000Z",
      metadata: {
        unexpected: true,
      },
    };

    expect(parseMessage(message)).toEqual(message);
  });
});
