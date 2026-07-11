import { describe, expect, it } from "vitest";
import { createAuthorizedToken, tokensEqual } from "../src/auth.js";

const INSTANCE_ID = "2d7856f5-8218-4ba6-9f6c-7aa459333ee1";

describe("bridge auth", () => {
  it("compares equal tokens in constant time", () => {
    const token = createAuthorizedToken(
      "session-1",
      "browser",
      INSTANCE_ID,
    );
    const differentToken = `${token.value.slice(0, -1)}${
      token.value.endsWith("0") ? "1" : "0"
    }`;

    expect(tokensEqual(token.value, token.value)).toBe(true);
    expect(tokensEqual(token.value, differentToken)).toBe(false);
    expect(tokensEqual(token.value, `${token.value}extra`)).toBe(false);
  });

  it("creates random 24-hour instance-bound session tokens", () => {
    const now = new Date("2026-07-09T12:00:00.000Z");

    const first = createAuthorizedToken(
      "session-1",
      "browser",
      INSTANCE_ID,
      now,
    );
    const second = createAuthorizedToken(
      "session-1",
      "browser",
      INSTANCE_ID,
      now,
    );

    expect(first).toMatchObject({
      sessionId: "session-1",
      role: "browser",
      bridgeInstanceId: INSTANCE_ID,
    });
    expect(first.value).toMatch(/^[a-f0-9]{64}$/);
    expect(second.value).not.toBe(first.value);
    expect(first.expiresAt.toISOString()).toBe("2026-07-10T12:00:00.000Z");
  });

  it("rejects an invalid token issue time", () => {
    expect(() =>
      createAuthorizedToken(
        "session-1",
        "browser",
        INSTANCE_ID,
        new Date(Number.NaN),
      ),
    ).toThrow("Token issue time must be a valid Date");
  });

  it("rejects an issue time that cannot produce a valid expiration", () => {
    expect(() =>
      createAuthorizedToken(
        "session-1",
        "browser",
        INSTANCE_ID,
        new Date(8_640_000_000_000_000),
      ),
    ).toThrow("Token expiration must be a valid Date");
  });
});
