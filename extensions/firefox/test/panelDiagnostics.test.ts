import { describe, expect, it } from "vitest";
import { PanelDiagnostics } from "../src/panelDiagnostics.js";

describe("PanelDiagnostics", () => {
  it("tracks pairing, transport, selection, sends, and the last error", () => {
    const diagnostics = new PanelDiagnostics();
    const sentAt = new Date("2026-07-10T15:00:00.000Z");

    diagnostics.setConnectionState("connected");
    diagnostics.setPaired(true);
    diagnostics.recordSelection(
      [{ type: "css-rule" }, { type: "dom-attribute" }],
      2,
    );
    diagnostics.recordMessageSent(sentAt);
    diagnostics.recordError({
      code: "bridge.noIdeClient",
      message: "No IDE client is connected",
    });

    expect(diagnostics.snapshot()).toEqual({
      connectionState: "connected",
      paired: true,
      lastMessageSentAt: sentAt,
      lastError: {
        code: "bridge.noIdeClient",
        message: "No IDE client is connected",
      },
      inaccessibleStylesheetCount: 2,
      matchedCssFactCount: 1,
    });
  });
});
