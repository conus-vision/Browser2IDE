import { describe, expect, it } from "vitest";
import {
  loadPanelSettings,
  resetPairing,
  savePanelSettings,
} from "../src/panelState.js";

describe("panel persisted state", () => {
  it("stores bridge credentials without ever persisting a pairing code", async () => {
    const memory: Record<string, unknown> = {};
    const writes: Record<string, unknown>[] = [];
    const storage = {
      async get(keys: string[]) {
        return Object.fromEntries(keys.map((key) => [key, memory[key]]));
      },
      async set(values: Record<string, unknown>) {
        writes.push(values);
        Object.assign(memory, values);
      },
      async remove(keys: string[]) {
        for (const key of keys) delete memory[key];
      },
    };

    await savePanelSettings(storage, {
      bridgeUrl: "ws://127.0.0.1:48735",
      sessionId: "session-1",
      authToken: "browser-token",
    });

    expect(writes).toEqual([
      {
        browser2ideBridgeUrl: "ws://127.0.0.1:48735",
        browser2ideSessionId: "session-1",
        browser2ideAuthToken: "browser-token",
      },
    ]);
    expect(JSON.stringify(memory)).not.toContain("pairing");
    await expect(loadPanelSettings(storage)).resolves.toEqual({
      bridgeUrl: "ws://127.0.0.1:48735",
      sessionId: "session-1",
      authToken: "browser-token",
    });

    await resetPairing(storage);
    await expect(loadPanelSettings(storage)).resolves.toEqual({
      bridgeUrl: "ws://127.0.0.1:48735",
      sessionId: "session-1",
      authToken: undefined,
    });
  });

  it("uses loopback defaults for a new panel", async () => {
    const storage = {
      async get() {
        return {};
      },
      async set() {},
      async remove() {},
    };

    await expect(loadPanelSettings(storage)).resolves.toEqual({
      bridgeUrl: "ws://127.0.0.1:48735",
      sessionId: "default",
      authToken: undefined,
    });
  });
});
