import { describe, expect, it } from "vitest";
import {
  loadPanelSettings,
  parseLinkCode,
  resetPanelSettings,
  savePanelSettings,
  type PanelStorage,
} from "../src/panelState.js";

const COMPLETE_SETTINGS = {
  bridgeUrl: "ws://127.0.0.1:48735",
  credentials: {
    sessionId: "session-1",
    bridgeInstanceId: "2d7856f5-8218-4ba6-9f6c-7aa459333ee1",
    authToken: "browser-token",
  },
} as const;

describe("parseLinkCode", () => {
  it.each(["4873507", "48735 07", "48735-07"])(
    "normalizes %s and preserves a leading-zero PIN",
    (value) => {
      expect(parseLinkCode(value)).toEqual({
        code: "4873507",
        url: "ws://127.0.0.1:48735",
        pin: "07",
      });
    },
  );

  it.each(["487350", "48735070", "48735a7", "４８７３５０７"])(
    "rejects %s unless it contains exactly seven ASCII digits",
    (value) => {
      expect(() => parseLinkCode(value)).toThrow("seven digits");
    },
  );

  it.each(["0999907", "6553607"])(
    "rejects the out-of-range port in %s",
    (value) => {
      expect(() => parseLinkCode(value)).toThrow("port");
    },
  );
});

describe("panel persisted state", () => {
  it("stores and loads only a URL with complete authenticated credentials", async () => {
    const { memory, storage, writes } = createMemoryStorage();

    await savePanelSettings(storage, COMPLETE_SETTINGS);

    expect(writes).toEqual([
      {
        browser2ideBridgeUrl: COMPLETE_SETTINGS.bridgeUrl,
        browser2ideSessionId: COMPLETE_SETTINGS.credentials.sessionId,
        browser2ideBridgeInstanceId:
          COMPLETE_SETTINGS.credentials.bridgeInstanceId,
        browser2ideAuthToken: COMPLETE_SETTINGS.credentials.authToken,
      },
    ]);
    expect(Object.keys(memory)).toEqual([
      "browser2ideBridgeUrl",
      "browser2ideSessionId",
      "browser2ideBridgeInstanceId",
      "browser2ideAuthToken",
    ]);
    await expect(loadPanelSettings(storage)).resolves.toEqual(
      COMPLETE_SETTINGS,
    );
  });

  it("starts without a saved link", async () => {
    const { storage } = createMemoryStorage();

    await expect(loadPanelSettings(storage)).resolves.toBeUndefined();
  });

  it.each([
    ["URL", { browser2ideBridgeUrl: COMPLETE_SETTINGS.bridgeUrl }],
    [
      "legacy credentials without an instance",
      {
        browser2ideBridgeUrl: COMPLETE_SETTINGS.bridgeUrl,
        browser2ideSessionId: COMPLETE_SETTINGS.credentials.sessionId,
        browser2ideAuthToken: COMPLETE_SETTINGS.credentials.authToken,
      },
    ],
    [
      "credentials without a token",
      {
        browser2ideBridgeUrl: COMPLETE_SETTINGS.bridgeUrl,
        browser2ideSessionId: COMPLETE_SETTINGS.credentials.sessionId,
        browser2ideBridgeInstanceId:
          COMPLETE_SETTINGS.credentials.bridgeInstanceId,
      },
    ],
  ])("rejects and clears incomplete stored %s", async (_label, initial) => {
    const { memory, removals, storage } = createMemoryStorage(initial);

    await expect(loadPanelSettings(storage)).resolves.toBeUndefined();

    expect(memory).toEqual({});
    expect(removals).toEqual([
      [
        "browser2ideBridgeUrl",
        "browser2ideSessionId",
        "browser2ideBridgeInstanceId",
        "browser2ideAuthToken",
      ],
    ]);
  });

  it("resets every persisted link field", async () => {
    const { memory, storage } = createMemoryStorage({
      browser2ideBridgeUrl: COMPLETE_SETTINGS.bridgeUrl,
      browser2ideSessionId: COMPLETE_SETTINGS.credentials.sessionId,
      browser2ideBridgeInstanceId:
        COMPLETE_SETTINGS.credentials.bridgeInstanceId,
      browser2ideAuthToken: COMPLETE_SETTINGS.credentials.authToken,
    });

    await resetPanelSettings(storage);

    expect(memory).toEqual({});
    await expect(loadPanelSettings(storage)).resolves.toBeUndefined();
  });
});

function createMemoryStorage(initial: Record<string, unknown> = {}) {
  const memory = { ...initial };
  const writes: Record<string, unknown>[] = [];
  const removals: string[][] = [];
  const storage: PanelStorage = {
    async get(keys) {
      return Object.fromEntries(keys.map((key) => [key, memory[key]]));
    },
    async set(values) {
      writes.push(values);
      Object.assign(memory, values);
    },
    async remove(keys) {
      removals.push([...keys]);
      for (const key of keys) delete memory[key];
    },
  };
  return { memory, removals, storage, writes };
}
