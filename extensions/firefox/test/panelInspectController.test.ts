import { describe, expect, it } from "vitest";
import { PanelInspectController } from "../src/panelInspectController.js";

describe("PanelInspectController", () => {
  it("disables content inspection when the bridge disconnects", async () => {
    const messages: unknown[] = [];
    const controller = new PanelInspectController(async (message) => {
      messages.push(message);
    });

    await expect(controller.setEnabled(true)).rejects.toThrow("No inspected tab");
    controller.setTabId(12);
    await controller.setEnabled(true);
    await controller.disable();
    await controller.disable();

    expect(messages).toEqual([
      { type: "enableInspectMode", tabId: 12 },
      { type: "disableInspectMode", tabId: 12 },
    ]);
    expect(controller.enabled).toBe(false);
  });

  it("stays locally disabled and retries a rejected remote disable", async () => {
    const messages: unknown[] = [];
    let rejectNextDisable = true;
    const controller = new PanelInspectController(async (message) => {
      messages.push(message);
      if (
        rejectNextDisable &&
        isRecord(message) &&
        message.type === "disableInspectMode"
      ) {
        rejectNextDisable = false;
        throw new Error("Background did not disable inspection");
      }
    });

    controller.setTabId(12);
    await controller.setEnabled(true);

    await expect(controller.disable()).rejects.toThrow(
      "Background did not disable inspection",
    );
    expect(controller.enabled).toBe(false);

    await controller.disable();

    expect(messages).toEqual([
      { type: "enableInspectMode", tabId: 12 },
      { type: "disableInspectMode", tabId: 12 },
      { type: "disableInspectMode", tabId: 12 },
    ]);
    expect(controller.enabled).toBe(false);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
