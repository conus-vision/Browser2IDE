import { describe, expect, it } from "vitest";
import type {
  ErrorMessage,
  InspectMessage,
} from "@browser2ide/protocol";
import {
  DiagnosticsTracker,
  writeBridgeDiagnostics,
} from "../src/diagnostics.js";
import type { ResolvedReference } from "../src/references/sourceTypes.js";

describe("DiagnosticsTracker", () => {
  it("tracks the latest inspect, resolution summary, and protocol error", () => {
    const now = new Date("2026-07-10T15:00:00.000Z");
    const tracker = new DiagnosticsTracker({ now: () => now });

    tracker.recordInspect(inspectMessage());
    tracker.recordReferences([
      reference("matched", "file:///workspace/card.scss"),
      reference("unmapped", "file:///workspace/missing.css"),
      reference("unmapped", "file:///workspace/missing.css"),
      reference("external", "https://cdn.example/bootstrap.css"),
    ]);
    tracker.recordProtocolError(protocolError());

    expect(
      tracker.snapshot(
        {
          state: "running",
          url: "ws://127.0.0.1:48735",
          pairingCode: "123456",
          pairingExpiresAt: new Date("2026-07-10T15:02:00.000Z"),
          sessionId: "session-1",
        },
        "connected",
      ),
    ).toEqual({
      bridgeState: "running",
      clientState: "connected",
      url: "ws://127.0.0.1:48735",
      sessionId: "session-1",
      pairingCode: "123456",
      pairingExpiresAt: new Date("2026-07-10T15:02:00.000Z"),
      lastInspectAt: now,
      factsReceived: 2,
      referencesResolved: 4,
      unmappedSources: ["file:///workspace/missing.css"],
      externalCssCount: 1,
      lastProtocolError: {
        code: "bridge.noBrowserClient",
        message: "No browser client is connected",
      },
    });
  });

  it("writes every visible diagnostic field to the output channel", () => {
    const lines: string[] = [];
    const output = {
      appendLine: (value: string) => lines.push(value),
      show() {},
    };
    const tracker = new DiagnosticsTracker();
    tracker.recordInspect(inspectMessage());

    writeBridgeDiagnostics(
      output,
      tracker.snapshot(
        {
          state: "running",
          url: "ws://127.0.0.1:48735",
          pairingCode: "123456",
          pairingExpiresAt: new Date("2026-07-10T15:02:00.000Z"),
          sessionId: "session-1",
        },
        "connected",
      ),
    );

    expect(lines).toEqual([
      "bridge=running client=connected url=ws://127.0.0.1:48735 session=session-1",
      "pairing=123456 expires=2026-07-10T15:02:00.000Z",
      expect.stringMatching(/^lastInspect=.+ facts=2$/),
      "references=0 unmapped=none externalCss=0",
      "protocolError=none",
    ]);
  });
});

function inspectMessage(): InspectMessage {
  return {
    protocolVersion: 1,
    type: "inspect",
    messageId: "inspect-1",
    sessionId: "session-1",
    source: { role: "browser", id: "browser-1", metadata: {} },
    subject: { selector: ".card", metadata: {} },
    facts: [
      {
        type: "css-rule",
        selector: ".card",
        property: "display",
        value: "grid",
        metadata: {},
      },
      {
        type: "dom-attribute",
        name: "role",
        value: "region",
        metadata: {},
      },
    ],
    context: { url: "http://localhost:3000", metadata: {} },
    metadata: {},
  };
}

function protocolError(): ErrorMessage {
  return {
    protocolVersion: 1,
    type: "error",
    messageId: "error-1",
    code: "bridge.noBrowserClient",
    message: "No browser client is connected",
    metadata: {},
  };
}

function reference(
  status: ResolvedReference["status"],
  uri: string,
): ResolvedReference {
  return {
    kind: "style-rule",
    relation: "styles",
    label: ".card",
    source: { uri, line: 1, column: 1, metadata: {} },
    confidence: "unknown",
    status,
    metadata: {},
    diagnostics: [],
  };
}
