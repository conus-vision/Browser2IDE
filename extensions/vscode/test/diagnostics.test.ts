import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  type ErrorMessage,
  type InspectMessage,
} from "@browser2ide/protocol";
import {
  DiagnosticsTracker,
  writeBridgeDiagnostics,
} from "../src/diagnostics.js";
import type { BridgeSnapshot } from "../src/bridgeManager.js";
import type { SourceResolution } from "../src/sourcePlugins/types.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

describe("DiagnosticsTracker", () => {
  it("tracks bridge identity, browser count, source activity, and protocol errors", () => {
    const now = new Date("2026-07-10T15:00:00.000Z");
    const tracker = new DiagnosticsTracker({ now: () => now });

    tracker.recordInspect(inspectMessage());
    tracker.recordResolution(resolution());
    tracker.recordProtocolError(protocolError());

    expect(tracker.snapshot(bridgeSnapshot(), "connected")).toEqual({
      bridgeState: "running",
      clientState: "connected",
      url: "ws://127.0.0.1:48735",
      port: 48_735,
      sessionId: "session-1",
      bridgeInstanceId: INSTANCE_ID,
      linkedBrowserCount: 1,
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
      `bridge=running client=connected url=ws://127.0.0.1:48735 port=48735 session=session-1 instance=${INSTANCE_ID} browsers=1`,
      expect.stringMatching(/^lastInspect=.+ targets=2 facts=3$/),
      "sources matches=2 pluginDiagnostics=1",
      "protocolError=none",
    ]);
  });

  it("whitelists diagnostics so link secrets and token-like values are absent", () => {
    const tracker = new DiagnosticsTracker();
    const bridge = {
      ...bridgeSnapshot(),
      pin: "97",
      linkCode: "4873597",
      authToken: "diagnostic-auth-token-secret",
      browserToken: "diagnostic-browser-token-secret",
    } as BridgeSnapshot & {
      readonly authToken: string;
      readonly browserToken: string;
    };

    const diagnostics = tracker.snapshot(bridge, "connected");
    const serialized = JSON.stringify(diagnostics);

    expect(diagnostics).not.toHaveProperty("pin");
    expect(diagnostics).not.toHaveProperty("linkCode");
    expect(diagnostics).not.toHaveProperty("authToken");
    expect(diagnostics).not.toHaveProperty("browserToken");
    expect(serialized).not.toContain("4873597");
    expect(serialized).not.toContain("diagnostic-auth-token-secret");
    expect(serialized).not.toContain("diagnostic-browser-token-secret");
    expect(serialized).not.toMatch(/"(?:pin|linkCode|authToken|browserToken)"/);

    const lines: string[] = [];
    writeBridgeDiagnostics(
      { appendLine: (value) => lines.push(value), show() {} },
      diagnostics,
    );
    expect(lines.join("\n")).not.toContain("4873597");
    expect(lines.join("\n")).not.toMatch(/auth-token|browser-token/i);
  });
});

function inspectMessage(): InspectMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
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
    protocolVersion: PROTOCOL_VERSION,
    type: "error",
    messageId: "error-1",
    code: "bridge.noBrowserClient",
    message: "No browser client is connected",
    metadata: {},
  };
}

function bridgeSnapshot(): BridgeSnapshot {
  return {
    state: "running",
    url: "ws://127.0.0.1:48735",
    port: 48_735,
    pin: "07",
    linkCode: "4873507",
    bridgeInstanceId: INSTANCE_ID,
    sessionId: "session-1",
    linkedBrowserCount: 1,
  };
}
