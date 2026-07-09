import { createAuthorizedToken, createBridgeServer, PairingStore } from "@browser2ide/bridge";
import type {
  AuthorizedToken,
  BridgeServer,
  BridgeServerOptions,
  PairingCode,
} from "@browser2ide/bridge";
import type { BridgeConfiguration } from "./config.js";
import {
  PairingState,
  type SecretStorageLike,
  loadBrowserTokens,
  resetBrowserTokens,
  storeBrowserToken,
} from "./pairing.js";

export type BridgeManagerState = "stopped" | "starting" | "running" | "stopping" | "error";

export interface BridgeSnapshot {
  readonly state: BridgeManagerState;
  readonly url?: string;
  readonly pairingCode?: string;
  readonly pairingExpiresAt?: Date;
  readonly sessionId: string;
}

type ManagedBridge = Pick<
  BridgeServer,
  "start" | "stop" | "createPairingCode" | "getUrl" | "pairingStore"
>;

export interface BridgeManagerOptions {
  readonly configuration: BridgeConfiguration;
  readonly secrets: SecretStorageLike;
  readonly createBridge?: (options: BridgeServerOptions) => ManagedBridge;
  readonly maxPortAttempts?: number;
}

export class BridgeManager {
  private readonly pairingState = new PairingState();
  private readonly createBridge: (options: BridgeServerOptions) => ManagedBridge;
  private readonly maxPortAttempts: number;
  private bridge: ManagedBridge | undefined;
  private ideToken: AuthorizedToken | undefined;
  private state: BridgeManagerState = "stopped";
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private stopRequested = false;

  constructor(private readonly options: BridgeManagerOptions) {
    this.createBridge = options.createBridge ?? createBridgeServer;
    this.maxPortAttempts = options.maxPortAttempts ?? 10;
  }

  start(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise.then(() => this.start());
    }
    if (this.state === "running") {
      return Promise.resolve();
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.stopRequested = false;
    this.startPromise = this.startBridge().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopRequested = true;
    this.stopPromise = this.stopBridge().finally(() => {
      this.stopPromise = undefined;
    });
    return this.stopPromise;
  }

  async resetPairing(): Promise<void> {
    await resetBrowserTokens(this.options.secrets, this.options.configuration.sessionId);
    this.bridge?.pairingStore.revokeTokens(this.options.configuration.sessionId, "browser");
  }

  snapshot(): BridgeSnapshot {
    const pairing = this.pairingState.current();
    return {
      state: this.state,
      url: this.bridge?.getUrl(),
      pairingCode: pairing?.code,
      pairingExpiresAt: pairing?.expiresAt,
      sessionId: this.options.configuration.sessionId,
    };
  }

  getIdeToken(): string | undefined {
    return this.ideToken?.value;
  }

  private async startBridge(): Promise<void> {
    this.state = "starting";
    const { configuration, secrets } = this.options;
    const browserTokens = await loadBrowserTokens(secrets, configuration.sessionId);
    const ideToken = createAuthorizedToken(configuration.sessionId, "ide");
    const pairingStore = new PairingStore({
      authorizedTokens: [...browserTokens, ideToken],
      onTokenCreated: (token) => {
        if (token.role === "browser") {
          void storeBrowserToken(secrets, token);
        }
      },
    });

    try {
      const bridge = await this.startOnAvailablePort(pairingStore);
      if (this.stopRequested) {
        await bridge.stop();
        this.state = "stopped";
        return;
      }

      this.bridge = bridge;
      this.ideToken = ideToken;
      this.pairingState.set(bridge.createPairingCode(configuration.sessionId));
      this.state = "running";
    } catch (error) {
      this.state = "error";
      throw error;
    }
  }

  private async startOnAvailablePort(pairingStore: PairingStore): Promise<ManagedBridge> {
    const { bridgePort, sessionId } = this.options.configuration;
    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxPortAttempts; attempt += 1) {
      try {
        const bridge = this.createBridge({
          port: bridgePort + attempt,
          sessionId,
          pairingStore,
        });
        await bridge.start();
        return bridge;
      } catch (error) {
        lastError = error;
        if (!isAddressInUse(error)) {
          throw error;
        }
      }
    }

    throw lastError ?? new Error("Unable to start Browser2IDE bridge");
  }

  private async stopBridge(): Promise<void> {
    this.state = "stopping";
    await this.startPromise?.catch(() => undefined);
    const bridge = this.bridge;
    this.bridge = undefined;
    this.ideToken = undefined;
    this.pairingState.clear();
    await bridge?.stop();
    this.state = "stopped";
  }
}

function isAddressInUse(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EADDRINUSE");
}
