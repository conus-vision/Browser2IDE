import { describe, expect, it } from "vitest";
import { PanelDiagnostics } from "../src/panelDiagnostics.js";

const LINK = {
  url: "ws://127.0.0.1:48735",
  sessionId: "session-1",
  bridgeInstanceId: "2d7856f5-8218-4ba6-9f6c-7aa459333ee1",
} as const;

describe("PanelDiagnostics", () => {
  it("tracks link identity, transport, selection, sends, and the last error", () => {
    const diagnostics = new PanelDiagnostics();
    const sentAt = new Date("2026-07-10T15:00:00.000Z");

    diagnostics.setConnectionState("connected");
    diagnostics.setLink(LINK);
    diagnostics.recordSelection(
      [
        { facts: [{ type: "css-rule" }, { type: "dom-attribute" }] },
        { facts: [{ type: "css-rule" }] },
      ],
      2,
    );
    diagnostics.recordMessageSent(sentAt);
    diagnostics.recordError({
      code: "bridge.noIdeClient",
      message: "No IDE client is connected",
    });

    expect(diagnostics.snapshot()).toEqual({
      connectionState: "connected",
      link: LINK,
      lastMessageSentAt: sentAt,
      lastError: {
        code: "bridge.noIdeClient",
        message: "No IDE client is connected",
      },
      inaccessibleStylesheetCount: 2,
      matchedCssFactCount: 2,
    });
  });

  it.each([
    ["auth.instanceChanged", "Saved link is no longer valid"],
    ["auth.tokenRejected", "Saved link is no longer valid"],
    ["link.rejected", "Link request was rejected"],
    ["link.rateLimited", "Link requests are temporarily rate-limited"],
  ] as const)("sanitizes %s without retaining supplied secrets", (code, message) => {
    const diagnostics = new PanelDiagnostics();
    const sensitive = "4873507/browser-token";

    diagnostics.recordError({ code, message: `Rejected ${sensitive}` });

    expect(diagnostics.snapshot().lastError).toEqual({ code, message });
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain(sensitive);
  });

  it("resets link, transport, selection, send, and error diagnostics", () => {
    const diagnostics = new PanelDiagnostics();
    diagnostics.setConnectionState("connected");
    diagnostics.setLink(LINK);
    diagnostics.recordSelection([{ facts: [{ type: "css-rule" }] }], 1);
    diagnostics.recordMessageSent();
    diagnostics.recordError({ message: "Previous error" });

    diagnostics.reset();

    expect(diagnostics.snapshot()).toEqual({
      connectionState: "disconnected",
      link: undefined,
      lastMessageSentAt: undefined,
      lastError: undefined,
      inaccessibleStylesheetCount: 0,
      matchedCssFactCount: 0,
    });
  });
});
