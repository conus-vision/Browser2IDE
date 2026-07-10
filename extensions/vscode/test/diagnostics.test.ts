import { describe, expect, it } from "vitest";
import type { ErrorMessage, InspectMessage } from "@browser2ide/protocol";
import {
  DiagnosticsTracker,
  writeBridgeDiagnostics,
} from "../src/diagnostics.js";
import type { SourceResolution } from "../src/sourcePlugins/types.js";

describe("DiagnosticsTracker", () => {
  it("tracks targets, facts, active matches, plugin diagnostics, and protocol errors", () => {
    const now = new Date("2026-07-10T15:00:00.000Z");
    const tracker = new DiagnosticsTracker({ now: () => now });

    tracker.recordInspect(inspectMessage());
    tracker.recordResolution(resolution());
    tracker.recordProtocolError(protocolError());

    expect(tracker.snapshot(bridgeSnapshot(), "connected")).toEqual({
      bridgeState: "running",
      clientState: "connected",
      url: "ws://127.0.0.1:48735",
      sessionId: "session-1",
      pairingCode: "123456",
      pairingExpiresAt: new Date("2026-07-10T15:02:00.000Z"),
      lastInspectAt: now,
      targetsReceived: 2,
      factsReceived: 3,
      matchesResolved: 2,
      pluginDiagnostics: 1,
      lastProtocolError: {
        code: "bridge.noBrowserClient",
        message: "No browser client is connected",
      },
    });
  });

  it("writes every visible diagnostic field to the output channel", () => {
    const lines: string[] = [];
    const tracker = new DiagnosticsTracker();
    tracker.recordInspect(inspectMessage());
    tracker.recordResolution(resolution());

    writeBridgeDiagnostics(
      { appendLine: (value) => lines.push(value), show() {} },
      tracker.snapshot(bridgeSnapshot(), "connected"),
    );

    expect(lines).toEqual([
      "bridge=running client=connected url=ws://127.0.0.1:48735 session=session-1",
      "pairing=123456 expires=2026-07-10T15:02:00.000Z",
      expect.stringMatching(/^lastInspect=.+ targets=2 facts=3$/),
      "sources matches=2 pluginDiagnostics=1",
      "protocolError=none",
    ]);
  });
});

function inspectMessage(): InspectMessage {
  return {
    protocolVersion: 2,
    type: "inspect",
    messageId: "inspect-1",
    sessionId: "session-1",
    source: { role: "browser", id: "browser-1", metadata: {} },
    targets: [
      {
        role: "selected",
        depth: 0,
        subject: { selector: ".card", metadata: {} },
        facts: [cssFact(), domFact()],
        metadata: {},
      },
      {
        role: "parent",
        depth: 1,
        subject: { selector: ".layout", metadata: {} },
        facts: [cssFact()],
        metadata: {},
      },
    ],
    context: { url: "http://localhost:3000", metadata: {} },
    metadata: {},
  };
}

function resolution(): SourceResolution {
  return {
    selectionMessageId: "inspect-1",
    documentUri: "file:///workspace/card.scss",
    documentVersion: 1,
    matches: [
      {
        pluginId: "browser2ide.scss",
        targetRole: "selected",
        range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
        label: ".card",
        kind: "style-rule",
        relation: "styles",
        confidence: "sourcemap",
      },
      {
        pluginId: "browser2ide.scss",
        targetRole: "parent",
        range: { start: { line: 4, character: 0 }, end: { line: 6, character: 1 } },
        label: ".layout",
        kind: "style-rule",
        relation: "styles",
        confidence: "sourcemap",
      },
    ],
    diagnostics: [
      {
        pluginId: "browser2ide.scss",
        code: "scss.sourceMapMissing",
        message: "SCSS source map was not found",
        severity: "warning",
      },
    ],
  };
}

function cssFact() {
  return {
    type: "css-rule" as const,
    selector: ".card",
    property: "display",
    value: "grid",
    metadata: {},
  };
}

function domFact() {
  return {
    type: "dom-attribute" as const,
    name: "role",
    value: "region",
    metadata: {},
  };
}

function protocolError(): ErrorMessage {
  return {
    protocolVersion: 2,
    type: "error",
    messageId: "error-1",
    code: "bridge.noBrowserClient",
    message: "No browser client is connected",
    metadata: {},
  };
}

function bridgeSnapshot() {
  return {
    state: "running" as const,
    url: "ws://127.0.0.1:48735",
    pairingCode: "123456",
    pairingExpiresAt: new Date("2026-07-10T15:02:00.000Z"),
    sessionId: "session-1",
  };
}
