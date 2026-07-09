import { describe, expect, it } from "vitest";
import { PairingStore } from "../src/pairing.js";

describe("PairingStore", () => {
  it("generates a 6-digit pairing code with a 120-second expiry", () => {
    const now = new Date("2026-07-09T12:00:00.000Z");
    const store = new PairingStore({ now: () => now });

    const pairing = store.createPairingCode("session-1");

    expect(pairing.code).toMatch(/^\d{6}$/);
    expect(pairing.sessionId).toBe("session-1");
    expect(pairing.expiresAt.toISOString()).toBe("2026-07-09T12:02:00.000Z");
    expect(pairing.usedAt).toBeUndefined();
  });

  it("accepts a pair request only when the code matches, is unexpired, and unused", () => {
    let now = new Date("2026-07-09T12:00:00.000Z");
    const store = new PairingStore({ now: () => now });
    const pairing = store.createPairingCode("session-1");

    expect(store.acceptPairRequest("000000")).toBeUndefined();

    const accepted = store.acceptPairRequest(pairing.code);
    expect(accepted?.sessionId).toBe("session-1");
    expect(accepted?.authToken.value).toMatch(/^[a-f0-9]{64}$/);
    expect(accepted?.authToken.expiresAt.toISOString()).toBe(
      "2026-08-08T12:00:00.000Z",
    );

    expect(store.acceptPairRequest(pairing.code)).toBeUndefined();

    now = new Date("2026-07-09T12:03:00.000Z");
    const expired = store.createPairingCode("session-2");
    now = new Date("2026-07-09T12:05:01.000Z");
    expect(store.acceptPairRequest(expired.code)).toBeUndefined();
  });

  it("validates authorized tokens by session", () => {
    let now = new Date("2026-07-09T12:00:00.000Z");
    const store = new PairingStore({ now: () => now });
    const pairing = store.createPairingCode("session-1");
    const accepted = store.acceptPairRequest(pairing.code);

    expect(accepted).toBeDefined();
    expect(
      store.validateToken("session-1", accepted?.authToken.value ?? ""),
    ).toBe(true);
    expect(store.validateToken("session-2", accepted?.authToken.value ?? "")).toBe(
      false,
    );
    expect(store.validateToken("session-1", "bad-token")).toBe(false);

    now = new Date("2026-08-08T12:00:00.001Z");
    expect(
      store.validateToken("session-1", accepted?.authToken.value ?? ""),
    ).toBe(false);
  });
});
