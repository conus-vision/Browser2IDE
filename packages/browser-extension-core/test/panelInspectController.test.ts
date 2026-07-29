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

  it("re-enables remotely after a rejected disable left state uncertain", async () => {
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

    await controller.setEnabled(true);

    expect(messages).toEqual([
      { type: "enableInspectMode", tabId: 12 },
      { type: "disableInspectMode", tabId: 12 },
      { type: "enableInspectMode", tabId: 12 },
    ]);
    expect(controller.enabled).toBe(true);
  });

  it("resets local and remote state after transport disconnect", async () => {
    const messages: unknown[] = [];
    const controller = new PanelInspectController(async (message) => {
      messages.push(message);
    });

    controller.setTabId(12);
    await controller.setEnabled(true);
    controller.handleTransportDisconnect();

    expect(controller.enabled).toBe(false);
    await controller.setEnabled(true);

    expect(messages).toEqual([
      { type: "enableInspectMode", tabId: 12 },
      { type: "enableInspectMode", tabId: 12 },
    ]);
    expect(controller.enabled).toBe(true);
  });

  it("sends a trailing disable when toggled off during a pending enable", async () => {
    const messages: unknown[] = [];
    const enable = deferred<void>();
    const controller = new PanelInspectController((message) => {
      messages.push(message);
      return isRecord(message) && message.type === "enableInspectMode"
        ? enable.promise
        : Promise.resolve(undefined);
    });

    controller.setTabId(12);
    const enabling = controller.setEnabled(true);
    const disabling = controller.disable();

    expect(controller.enabled).toBe(false);
    expect(messages).toEqual([
      { type: "enableInspectMode", tabId: 12 },
    ]);

    enable.resolve();
    await Promise.all([enabling, disabling]);

    expect(messages).toEqual([
      { type: "enableInspectMode", tabId: 12 },
      { type: "disableInspectMode", tabId: 12 },
    ]);
    expect(controller.enabled).toBe(false);
  });
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
