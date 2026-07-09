import { describe, expect, it } from "vitest";
import {
  PairingState,
  loadBrowserTokens,
  resetBrowserTokens,
  serializeAuthorizedTokens,
  storeBrowserToken,
} from "../src/pairing.js";

class MemorySecrets {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

describe("extension pairing state", () => {
  it("keeps pairing codes only in memory until their bridge expiry", () => {
    let now = new Date("2026-07-10T12:00:00.000Z");
    const state = new PairingState(() => now);
    const pairing = {
      code: "123456",
      sessionId: "session-1",
      expiresAt: new Date("2026-07-10T12:02:00.000Z"),
    };

    state.set(pairing);
    expect(state.current()).toEqual(pairing);

    now = new Date("2026-07-10T12:02:00.000Z");
    expect(state.current()).toBeUndefined();
  });

  it("serializes, restores, and resets browser tokens for one session", async () => {
    const secrets = new MemorySecrets();
    const browserToken = {
      sessionId: "session-1",
      role: "browser" as const,
      value: "browser-token",
      expiresAt: new Date("2026-08-09T12:00:00.000Z"),
    };
    const ideToken = {
      sessionId: "session-1",
      role: "ide" as const,
      value: "ide-token",
      expiresAt: new Date("2026-08-09T12:00:00.000Z"),
    };

    expect(serializeAuthorizedTokens([browserToken, ideToken])).toBe(
      '[{"sessionId":"session-1","role":"browser","value":"browser-token","expiresAt":"2026-08-09T12:00:00.000Z"},{"sessionId":"session-1","role":"ide","value":"ide-token","expiresAt":"2026-08-09T12:00:00.000Z"}]',
    );

    await storeBrowserToken(secrets, browserToken);
    await storeBrowserToken(secrets, { ...browserToken, value: "browser-token-2" });
    expect(await loadBrowserTokens(secrets, "session-1")).toMatchObject([
      browserToken,
      { ...browserToken, value: "browser-token-2" },
    ]);

    await resetBrowserTokens(secrets, "session-1");
    expect(await loadBrowserTokens(secrets, "session-1")).toEqual([]);
  });
});
