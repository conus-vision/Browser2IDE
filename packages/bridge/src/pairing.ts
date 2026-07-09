import { randomInt } from "node:crypto";
import {
  createAuthorizedToken,
  tokensEqual,
  type AuthorizedToken,
} from "./auth.js";

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

interface PairingStoreOptions {
  readonly now?: () => Date;
}

const PAIRING_TTL_MS = 120_000;

export class PairingStore {
  private readonly pairings = new Map<string, PairingCode>();
  private readonly tokens = new Map<string, AuthorizedToken>();
  private readonly now: () => Date;

  constructor(options: PairingStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
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

  acceptPairRequest(code: string): AcceptedPairing | undefined {
    const pairing = this.pairings.get(code);
    const now = this.now();

    if (!pairing || pairing.usedAt || pairing.expiresAt.getTime() <= now.getTime()) {
      return undefined;
    }

    pairing.usedAt = now;
    const authToken = createAuthorizedToken(pairing.sessionId, now);
    this.tokens.set(authToken.sessionId, authToken);

    return {
      sessionId: pairing.sessionId,
      authToken,
    };
  }

  validateToken(sessionId: string, token: string): boolean {
    const stored = this.tokens.get(sessionId);
    const now = this.now();

    if (!stored || stored.expiresAt.getTime() <= now.getTime()) {
      return false;
    }

    return tokensEqual(stored.value, token);
  }

  private generateCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, "0");
  }
}
