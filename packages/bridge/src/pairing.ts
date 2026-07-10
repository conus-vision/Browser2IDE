import { randomInt } from "node:crypto";
import {
  createAuthorizedToken,
  tokensEqual,
  type AuthorizedToken,
} from "./auth.js";
import type { ClientRole, ProtocolErrorCode } from "@browser2ide/protocol";

export interface PairingCode {
  readonly code: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
  usedAt?: Date;
}

export type { AuthorizedToken };

export interface AcceptedPairing {
  readonly sessionId: string;
  readonly authToken: AuthorizedToken;
}

export type PairingAttempt =
  | { readonly accepted: AcceptedPairing }
  | {
      readonly errorCode: Extract<
        ProtocolErrorCode,
        "pairing.invalidCode" | "pairing.expiredCode"
      >;
    };

export interface PairingStoreOptions {
  readonly now?: () => Date;
  readonly authorizedTokens?: readonly AuthorizedToken[];
  readonly onTokenCreated?: (token: AuthorizedToken) => void;
}

const PAIRING_TTL_MS = 120_000;

export class PairingStore {
  private readonly pairings = new Map<string, PairingCode>();
  private readonly tokens = new Map<string, AuthorizedToken[]>();
  private readonly now: () => Date;
  private readonly onTokenCreated?: (token: AuthorizedToken) => void;

  constructor(options: PairingStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.onTokenCreated = options.onTokenCreated;

    for (const token of options.authorizedTokens ?? []) {
      this.preloadToken(token);
    }
  }

  createPairingCode(sessionId: string): PairingCode {
    let code = this.generateCode();
    while (this.pairings.has(code)) {
      code = this.generateCode();
    }

    const pairing: PairingCode = {
      code,
      sessionId,
      expiresAt: new Date(this.now().getTime() + PAIRING_TTL_MS),
    };

    this.pairings.set(code, pairing);
    return pairing;
  }

  acceptPairRequest(
    code: string,
    role: ClientRole = "browser",
  ): AcceptedPairing | undefined {
    const result = this.acceptPairRequestDetailed(code, role);
    return "accepted" in result ? result.accepted : undefined;
  }

  acceptPairRequestDetailed(
    code: string,
    role: ClientRole = "browser",
  ): PairingAttempt {
    const pairing = this.pairings.get(code);
    const now = this.now();

    if (!pairing || pairing.usedAt) {
      return { errorCode: "pairing.invalidCode" };
    }
    if (pairing.expiresAt.getTime() <= now.getTime()) {
      return { errorCode: "pairing.expiredCode" };
    }

    pairing.usedAt = now;
    const authToken = createAuthorizedToken(pairing.sessionId, role, now);
    this.addToken(authToken);
    this.onTokenCreated?.(authToken);

    return {
      accepted: {
        sessionId: pairing.sessionId,
        authToken,
      },
    };
  }

  validateToken(sessionId: string, role: ClientRole, token: string): boolean;
  validateToken(sessionId: string, token: string): boolean;
  validateToken(
    sessionId: string,
    roleOrToken: ClientRole | string,
    maybeToken?: string,
  ): boolean {
    const role = maybeToken === undefined ? undefined : (roleOrToken as ClientRole);
    const token = maybeToken ?? roleOrToken;
    const stored = this.tokens.get(sessionId) ?? [];
    const now = this.now();

    return stored.some(
      (authorized) =>
        authorized.expiresAt.getTime() > now.getTime() &&
        (role === undefined || authorized.role === role) &&
        tokensEqual(authorized.value, token),
    );
  }

  preloadToken(token: AuthorizedToken): void {
    if (token.expiresAt.getTime() > this.now().getTime()) {
      this.addToken(token);
    }
  }

  revokeTokens(sessionId: string, role: ClientRole): void {
    const remaining = (this.tokens.get(sessionId) ?? []).filter(
      (token) => token.role !== role,
    );

    if (remaining.length === 0) {
      this.tokens.delete(sessionId);
      return;
    }

    this.tokens.set(sessionId, remaining);
  }

  private addToken(token: AuthorizedToken): void {
    const tokens = this.tokens.get(token.sessionId) ?? [];
    tokens.push(token);
    this.tokens.set(token.sessionId, tokens);
  }

  private generateCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, "0");
  }
}
