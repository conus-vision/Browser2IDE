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
  private tokenPersistence: Promise<void> = Promise.resolve();
  private stopRequested = false;

  constructor(private readonly options: BridgeManagerOptions) {
    this.createBridge = options.createBridge ?? createBridgeServer;
    this.maxPortAttempts =
      options.maxPortAttempts ?? Math.max(1, 65_536 - options.configuration.bridgePort);
  }

  start(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise.then(() => this.start());
    }
    if (this.state === "running") {
      if (this.bridge) {
        this.pairingState.set(
          this.bridge.createPairingCode(this.options.configuration.sessionId),
        );
      }
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
    this.bridge?.pairingStore.revokeTokens(this.options.configuration.sessionId, "browser");
    await this.enqueueTokenOperation(() =>
      resetBrowserTokens(this.options.secrets, this.options.configuration.sessionId),
    );
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
          void this.enqueueTokenOperation(() => storeBrowserToken(secrets, token));
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
    const { bridgePort, bridgeUrl, sessionId } = this.options.configuration;
    const host = resolveLoopbackHost(bridgeUrl);
    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxPortAttempts; attempt += 1) {
      try {
        const bridge = this.createBridge({
          host,
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
    await this.tokenPersistence.catch(() => undefined);
    this.state = "stopped";
  }

  private enqueueTokenOperation(operation: () => Promise<void>): Promise<void> {
    const queued = this.tokenPersistence.catch(() => undefined).then(operation);
    void queued.catch(() => undefined);
    this.tokenPersistence = queued;
    return queued;
  }
}

function isAddressInUse(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EADDRINUSE");
}

function resolveLoopbackHost(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid Browser2IDE bridge URL: ${value}`);
  }

  if (url.protocol !== "ws:") {
    throw new Error("Browser2IDE managed bridge URL must use ws://");
  }

  const host = url.hostname === "[::1]" ? "::1" : url.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("Browser2IDE managed bridge must use a loopback host");
  }

  return host;
}
