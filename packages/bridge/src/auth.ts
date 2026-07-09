import { randomBytes, timingSafeEqual } from "node:crypto";

export interface AuthorizedToken {
  readonly sessionId: string;
  readonly value: string;
  readonly expiresAt: Date;
}

const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function tokensEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    timingSafeEqual(leftBuffer, leftBuffer);
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function createAuthorizedToken(
  sessionId: string,
  now = new Date(),
): AuthorizedToken {
  return {
    sessionId,
    value: randomBytes(TOKEN_BYTES).toString("hex"),
    expiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
  };
}
