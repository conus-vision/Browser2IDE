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
});
