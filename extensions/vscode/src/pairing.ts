import type { AuthorizedToken, PairingCode } from "@browser2ide/bridge";

export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

interface SerializedAuthorizedToken {
  readonly sessionId: string;
  readonly role: "browser" | "ide" | "simulator";
  readonly value: string;
  readonly expiresAt: string;
}

export class PairingState {
  private pairing: PairingCode | undefined;

  constructor(private readonly now: () => Date = () => new Date()) {}

  set(pairing: PairingCode): void {
    this.pairing = pairing;
  }

  current(): PairingCode | undefined {
    const pairing = this.pairing;
    if (pairing && pairing.expiresAt.getTime() <= this.now().getTime()) {
      this.pairing = undefined;
    }

    return this.pairing;
  }

  clear(): void {
    this.pairing = undefined;
  }
}

export function serializeAuthorizedTokens(
  tokens: readonly AuthorizedToken[],
): string {
  return JSON.stringify(
    tokens.map((token) => ({
      sessionId: token.sessionId,
      role: token.role,
      value: token.value,
      expiresAt: token.expiresAt.toISOString(),
    })),
  );
}

export async function loadBrowserTokens(
  secrets: SecretStorageLike,
  sessionId: string,
  now = new Date(),
): Promise<AuthorizedToken[]> {
  const stored = await secrets.get(secretKey(sessionId));
  if (!stored) {
    return [];
  }

  try {
    const tokens = JSON.parse(stored) as unknown;
    if (!Array.isArray(tokens)) {
      return [];
    }

    return tokens.flatMap((token) => parseBrowserToken(token, sessionId, now));
  } catch {
    return [];
  }
}

export async function storeBrowserToken(
  secrets: SecretStorageLike,
  token: AuthorizedToken,
): Promise<void> {
  if (token.role !== "browser") {
    return;
  }

  const tokens = await loadBrowserTokens(secrets, token.sessionId, new Date(0));
  await secrets.store(secretKey(token.sessionId), serializeAuthorizedTokens([...tokens, token]));
}

export async function resetBrowserTokens(
  secrets: SecretStorageLike,
  sessionId: string,
): Promise<void> {
  await secrets.delete(secretKey(sessionId));
}

function secretKey(sessionId: string): string {
  return `browser2ide.browserTokens.${sessionId}`;
}

function parseBrowserToken(
  value: unknown,
  sessionId: string,
  now: Date,
): AuthorizedToken[] {
  if (!isSerializedAuthorizedToken(value) || value.sessionId !== sessionId || value.role !== "browser") {
    return [];
  }

  const expiresAt = new Date(value.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    return [];
  }

  return [{ ...value, expiresAt }];
}

function isSerializedAuthorizedToken(value: unknown): value is SerializedAuthorizedToken {
  if (!value || typeof value !== "object") {
    return false;
  }

  const token = value as Partial<SerializedAuthorizedToken>;
  return (
    typeof token.sessionId === "string" &&
    (token.role === "browser" || token.role === "ide" || token.role === "simulator") &&
    typeof token.value === "string" &&
    typeof token.expiresAt === "string"
  );
}
