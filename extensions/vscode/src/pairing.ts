import type { AuthorizedToken, PairingCode } from "@browser2ide/bridge";

export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export interface PairingCodeInputOptions {
  readonly title: string;
  readonly prompt: string;
  readonly value: string;
  readonly valueSelection: [number, number];
  readonly ignoreFocusOut: boolean;
}

export interface PairingCodeCommandHost {
  refreshPairing(): Promise<void>;
  getPairing(): { readonly code?: string; readonly expiresAt?: Date };
  writeClipboard(value: string): PromiseLike<void>;
  showInputBox(options: PairingCodeInputOptions): PromiseLike<unknown>;
  showErrorMessage(message: string): PromiseLike<unknown>;
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

export async function showPairingCode(
  host: PairingCodeCommandHost,
): Promise<boolean> {
  try {
    await host.refreshPairing();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await host.showErrorMessage(
      `Browser2IDE could not create a pairing code: ${message}`,
    );
    return false;
  }

  const pairing = host.getPairing();
  if (!pairing.code) {
    await host.showErrorMessage(
      'Browser2IDE could not create a pairing code. Run "Browser2IDE: Open Diagnostics" for details.',
    );
    return false;
  }

  let copied = true;
  try {
    await host.writeClipboard(pairing.code);
  } catch {
    copied = false;
  }

  const deadline = pairing.expiresAt
    ? ` before ${pairing.expiresAt.toISOString()}`
    : "";
  await host.showInputBox({
    title: "Browser2IDE pairing code",
    prompt: `${copied ? "Copied to clipboard." : "Automatic copy failed."} Paste this code into Firefox${deadline}.`,
    value: pairing.code,
    valueSelection: [0, pairing.code.length],
    ignoreFocusOut: true,
  });

  return true;
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
