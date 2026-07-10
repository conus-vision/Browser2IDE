import { describe, expect, it } from "vitest";
import { createBackgroundRouter } from "../src/backgroundRouter.js";

describe("background routing", () => {
  it("injects and toggles inspect mode for the requested tab", async () => {
    const calls: unknown[] = [];
    const route = createBackgroundRouter({
      async executeScript(details) {
        calls.push(["inject", details]);
      },
      async sendTabMessage(tabId, message) {
        calls.push(["tab", tabId, message]);
      },
      async sendRuntimeMessage(message) {
        calls.push(["runtime", message]);
      },
    });

    await route({ type: "enableInspectMode", tabId: 17 }, {});
    await route({ type: "disableInspectMode", tabId: 17 }, {});

    expect(calls).toEqual([
      [
        "inject",
        { target: { tabId: 17 }, files: ["dist/contentScript.js"] },
      ],
      ["tab", 17, { type: "enableInspectMode" }],
      ["tab", 17, { type: "disableInspectMode" }],
    ]);
  });

  it("forwards selected payloads using the sender tab identity", async () => {
    const forwarded: unknown[] = [];
    const route = createBackgroundRouter({
      async executeScript() {},
      async sendTabMessage() {},
      async sendRuntimeMessage(message) {
        forwarded.push(message);
      },
    });
    const payload = { subject: { selector: ".card", metadata: {} } };

    await route({ type: "elementSelected", payload }, { tabId: 23 });
    await route({ type: "elementSelected", payload }, {});

    expect(forwarded).toEqual([
      { type: "browser2ide.selection", tabId: 23, payload },
    ]);
  });
});
