import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, parseMessage } from "../src/index.js";

const bridgeInstanceId = "2d7856f5-8218-4ba6-9f6c-7aa459333ee1";

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

function target(
  role: "selected" | "parent",
  depth: 0 | 1,
  selector: string,
  facts: readonly unknown[],
) {
  return {
    role,
    depth,
    subject: { selector, metadata: {} },
    facts,
    metadata: {},
  };
}

function inspectMessage(targets: readonly unknown[]) {
  return {
    protocolVersion: 3,
    type: "inspect",
    messageId: "inspect-v3",
    sessionId: "session-1",
    source,
    targets,
    context: { url: "http://localhost:3000/", metadata: {} },
    metadata: {},
  };
}

describe("Browser2IDE protocol schemas", () => {
  it.each([
    [
      "hello",
      {
        protocolVersion: 3,
        type: "hello",
        messageId: "msg-hello",
        sessionId: "session-1",
        authToken: "token-1",
        bridgeInstanceId,
        source,
        capabilities: ["inspect", "references"],
        metadata: {
          userAgent: "Vitest",
        },
      },
    ],
    [
      "linkRequest",
      {
        protocolVersion: 3,
        type: "linkRequest",
        messageId: "msg-link-request",
        pin: "07",
        source,
        metadata: {},
      },
    ],
    [
      "linkAccepted",
      {
        protocolVersion: 3,
        type: "linkAccepted",
        messageId: "msg-link-accepted",
        sessionId: "session-1",
        bridgeInstanceId,
        authToken: "a".repeat(64),
        expiresAt: "2026-07-09T15:00:00.000Z",
        metadata: {},
      },
    ],
    [
      "authenticated",
      {
        protocolVersion: 3,
        type: "authenticated",
        messageId: "msg-authenticated",
        sessionId: "session-1",
        bridgeInstanceId,
        metadata: {},
      },
    ],
    [
      "unlink",
      {
        protocolVersion: 3,
        type: "unlink",
        messageId: "msg-unlink",
        sessionId: "session-1",
        metadata: {},
      },
    ],
    [
      "inspect",
      {
        protocolVersion: 3,
        type: "inspect",
        messageId: "msg-inspect",
        sessionId: "session-1",
        source,
        targets: [
          {
            role: "selected",
            depth: 0,
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
            metadata: {},
          },
        ],
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
        protocolVersion: 3,
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
      "openSource command",
      {
        protocolVersion: 3,
        type: "command",
        messageId: "msg-open-source-command",
        command: "openSource",
        arguments: {
          source: sourceLocation,
          metadata: {
            origin: "inspect-panel",
          },
        },
        metadata: {},
      },
    ],
    [
      "highlightElement command",
      {
        protocolVersion: 3,
        type: "command",
        messageId: "msg-highlight-element-command",
        command: "highlightElement",
        arguments: {
          selector: "#root > button",
          metadata: {
            durationMs: 500,
          },
        },
        metadata: {},
      },
    ],
    [
      "error",
      {
        protocolVersion: 3,
        type: "error",
        messageId: "msg-error",
        code: "resolver.fileNotFound",
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
        protocolVersion: 3,
        type: "ping",
        messageId: "msg-ping",
        sentAt: "2026-07-09T14:00:00.000Z",
        metadata: {},
      },
    ],
    [
      "pong",
      {
        protocolVersion: 3,
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

  it.each(["7", "007", "aa"])("rejects invalid PIN %s", (pin) => {
    expect(() =>
      parseMessage({
        protocolVersion: 3,
        type: "linkRequest",
        messageId: "msg-invalid-pin",
        pin,
        source,
        metadata: {},
      }),
    ).toThrow();
  });

  it("rejects hello without a bridge instance", () => {
    expect(() =>
      parseMessage({
        protocolVersion: 3,
        type: "hello",
        messageId: "msg-hello-no-instance",
        sessionId: "session-1",
        authToken: "token-1",
        source,
        capabilities: ["inspect"],
        metadata: {},
      }),
    ).toThrow();
  });

  it("parses selected and immediate-parent inspect targets", () => {
    const message = inspectMessage([
      target("selected", 0, ".card", runtimeFacts),
      target("parent", 1, ".layout", runtimeFacts),
    ]);

    expect(parseMessage(message)).toEqual(message);
  });

  it("accepts a namespaced plugin runtime fact", () => {
    const fact = {
      type: "react.component",
      source: sourceLocation,
      payload: { componentName: "Card" },
      metadata: {},
    };

    expect(
      parseMessage(
        inspectMessage([target("selected", 0, ".card", [fact])]),
      ),
    ).toMatchObject({ targets: [{ facts: [fact] }] });
  });

  it.each([
    ["missing namespace", "react"],
    ["uppercase segment", "React.component"],
    ["empty segment", "react..component"],
    ["leading dot", ".react.component"],
    ["trailing dot", "react.component."],
    ["overlength name", `react.${"x".repeat(123)}`],
  ])("rejects a plugin fact with %s", (_name, type) => {
    expect(() =>
      parseMessage(inspectMessage([
        target("selected", 0, ".card", [{
          type,
          payload: {},
          metadata: {},
        }]),
      ])),
    ).toThrow();
  });

  it.each([
    ["undefined", { value: undefined }],
    ["function", { value: () => undefined }],
    ["NaN", { value: Number.NaN }],
    ["Infinity", { value: Number.POSITIVE_INFINITY }],
  ])("rejects a plugin fact with %s in its payload", (_name, payload) => {
    expect(() =>
      parseMessage(inspectMessage([
        target("selected", 0, ".card", [{
          type: "react.component",
          payload,
          metadata: {},
        }]),
      ])),
    ).toThrow();
  });

  it.each([
    ["no selected target", [target("parent", 1, ".layout", runtimeFacts)]],
    [
      "duplicate selected targets",
      [
        target("selected", 0, ".card", runtimeFacts),
        target("selected", 0, ".featured", runtimeFacts),
      ],
    ],
    [
      "parent with the wrong depth",
      [
        target("selected", 0, ".card", runtimeFacts),
        target("parent", 0, ".layout", runtimeFacts),
      ],
    ],
  ])("rejects %s", (_name, targets) => {
    expect(() => parseMessage(inspectMessage(targets))).toThrow();
  });

  it("rejects the preceding protocol version", () => {
    expect(() =>
      parseMessage({
        protocolVersion: PROTOCOL_VERSION - 1,
        type: "ping",
        messageId: "old-ping",
        sentAt: "2026-07-11T00:00:00.000Z",
        metadata: {},
      }),
    ).toThrow();
  });

  it("rejects the legacy code-exchange request", () => {
    const legacyType = ["pair", "Request"].join("");
    const legacyCodeField = ["pairing", "Code"].join("");
    expect(() =>
      parseMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: legacyType,
        messageId: "msg-legacy-pair-request",
        [legacyCodeField]: "123456",
        source,
        metadata: {},
      }),
    ).toThrow();
  });

  it("rejects the legacy code-exchange response", () => {
    const legacyType = ["pair", "Accepted"].join("");
    expect(() =>
      parseMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: legacyType,
        messageId: "msg-legacy-pair-accepted",
        sessionId: "session-1",
        authToken: "token-1",
        expiresAt: "2026-07-09T15:00:00.000Z",
        metadata: {},
      }),
    ).toThrow();
  });

  it("accepts only the structured Browser2IDE error vocabulary", () => {
    const codes = [
      "link.invalidCode",
      "link.unreachable",
      "link.rejected",
      "link.rateLimited",
      "auth.tokenRejected",
      "auth.instanceChanged",
      "protocol.invalidMessage",
      "bridge.noIdeClient",
      "bridge.noBrowserClient",
      "bridge.offline",
      "resolver.fileNotFound",
      "resolver.sourceMapFailed",
      "browser.stylesheetInaccessible",
    ];

    for (const code of codes) {
      expect(
        parseMessage({
          protocolVersion: 3,
          type: "error",
          messageId: `error-${code}`,
          code,
          message: "Diagnostic",
          metadata: {},
        }),
      ).toMatchObject({ code });
    }

    expect(() =>
      parseMessage({
        protocolVersion: 3,
        type: "error",
        messageId: "error-unknown",
        code: "UNKNOWN_ERROR",
        message: "Diagnostic",
        metadata: {},
      }),
    ).toThrow();
  });

  it("rejects inspect messages with facts nested inside the subject", () => {
    expect(() =>
      parseMessage({
        protocolVersion: 3,
        type: "inspect",
        messageId: "msg-inspect-nested-facts",
        sessionId: "session-1",
        source,
        targets: [
          {
            role: "selected",
            depth: 0,
            subject: {
              selector: "#root > button",
              facts: runtimeFacts,
              metadata: {},
            },
            facts: runtimeFacts,
            metadata: {},
          },
        ],
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
        protocolVersion: 4,
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
        protocolVersion: 3,
        messageId: "msg-missing-type",
        metadata: {},
      }),
    ).toThrow();
  });

  it("rejects hello messages without session auth", () => {
    expect(() =>
      parseMessage({
        protocolVersion: 3,
        type: "hello",
        messageId: "msg-hello-no-auth",
        source,
        capabilities: ["inspect"],
        metadata: {},
      }),
    ).toThrow();
  });

  it("rejects source locations with zero-based positions", () => {
    expect(() =>
      parseMessage({
        protocolVersion: 3,
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

  it("rejects source locations with reversed ranges", () => {
    expect(() =>
      parseMessage({
        protocolVersion: 3,
        type: "references",
        messageId: "msg-reversed-location",
        subject: {
          selector: "#root",
          metadata: {},
        },
        references: [
          {
            ...reference,
            source: {
              ...sourceLocation,
              endLine: 11,
              endColumn: 8,
            },
          },
        ],
        metadata: {},
      }),
    ).toThrow();
  });

  it("rejects source locations with only one end position", () => {
    expect(() =>
      parseMessage({
        protocolVersion: 3,
        type: "references",
        messageId: "msg-missing-end-pair",
        subject: {
          selector: "#root",
          metadata: {},
        },
        references: [
          {
            ...reference,
            source: {
              uri: sourceLocation.uri,
              line: sourceLocation.line,
              column: sourceLocation.column,
              endLine: sourceLocation.endLine,
              metadata: {},
            },
          },
        ],
        metadata: {},
      }),
    ).toThrow();
  });

  it("rejects unsupported command names", () => {
    expect(() =>
      parseMessage({
        protocolVersion: 3,
        type: "command",
        messageId: "msg-unknown-command",
        command: "unknownCommand",
        arguments: {
          metadata: {},
        },
        metadata: {},
      }),
    ).toThrow();
  });

  it("rejects openSource commands with invalid source positions", () => {
    expect(() =>
      parseMessage({
        protocolVersion: 3,
        type: "command",
        messageId: "msg-invalid-open-source",
        command: "openSource",
        arguments: {
          source: {
            ...sourceLocation,
            line: 0,
          },
          metadata: {},
        },
        metadata: {},
      }),
    ).toThrow();
  });

  it("rejects unknown top-level fields while preserving metadata entries", () => {
    expect(() =>
      parseMessage({
        protocolVersion: 3,
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
      protocolVersion: 3,
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
