import { describe, expect, it } from "vitest";
import { createBackgroundRouter } from "../src/backgroundRouter.js";

describe("background routing", () => {
  it("does not accept inspect commands outside an owning port", async () => {
    const calls: unknown[] = [];
    const route = createBackgroundRouter({
      async sendRuntimeMessage(message) {
        calls.push(["runtime", message]);
      },
    });

    const enabled = await route(
      { type: "enableInspectMode", tabId: 17 },
      {},
    );
    const disabled = await route(
      { type: "disableInspectMode", tabId: 17 },
      {},
    );

    expect(enabled).toBeUndefined();
    expect(disabled).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("forwards selected payloads using the sender tab identity", async () => {
    const forwarded: unknown[] = [];
    const route = createBackgroundRouter({
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
