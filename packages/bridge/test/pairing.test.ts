import { describe, expect, it } from "vitest";
import { createAuthorizedToken } from "../src/auth.js";
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

  it("keeps multiple role-bound tokens for the same session", () => {
    const store = new PairingStore();
    const browserPairing = store.createPairingCode("session-1");
    const idePairing = store.createPairingCode("session-1");

    const browserToken = store.acceptPairRequest(browserPairing.code, "browser")?.authToken;
    const ideToken = store.acceptPairRequest(idePairing.code, "ide")?.authToken;

    expect(browserToken?.role).toBe("browser");
    expect(ideToken?.role).toBe("ide");
    expect(store.validateToken("session-1", "browser", browserToken?.value ?? "")).toBe(
      true,
    );
    expect(store.validateToken("session-1", "ide", ideToken?.value ?? "")).toBe(true);
    expect(store.validateToken("session-1", "ide", browserToken?.value ?? "")).toBe(
      false,
    );
  });

  it("preloads valid tokens, notifies persistence, and revokes one role", () => {
    const now = new Date("2026-07-09T12:00:00.000Z");
    const browserToken = createAuthorizedToken("session-1", "browser", now);
    const ideToken = createAuthorizedToken("session-1", "ide", now);
    const persisted: string[] = [];
    const store = new PairingStore({
      now: () => now,
      authorizedTokens: [browserToken, ideToken],
      onTokenCreated: (token) => persisted.push(token.value),
    });

    expect(store.validateToken("session-1", "browser", browserToken.value)).toBe(true);
    expect(store.validateToken("session-1", "ide", ideToken.value)).toBe(true);

    const pairing = store.createPairingCode("session-2");
    const accepted = store.acceptPairRequest(pairing.code, "browser");
    expect(persisted).toEqual([accepted?.authToken.value]);

    store.revokeTokens("session-1", "browser");
    expect(store.validateToken("session-1", "browser", browserToken.value)).toBe(false);
    expect(store.validateToken("session-1", "ide", ideToken.value)).toBe(true);
  });
});
