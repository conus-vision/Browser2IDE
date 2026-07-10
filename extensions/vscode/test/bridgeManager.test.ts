import { describe, expect, it } from "vitest";
import type { PairingStore } from "@browser2ide/bridge";
import { BridgeClient } from "../src/bridgeClient.js";
import { BridgeManager } from "../src/bridgeManager.js";

class MemorySecrets {
  async get(): Promise<string | undefined> {
    return undefined;
  }

  async store(): Promise<void> {}

  async delete(): Promise<void> {}
}

class DeferredSecrets extends MemorySecrets {
  readonly operations: string[] = [];
  private releaseStore: (() => void) | undefined;
  private markStoreStarted: () => void = () => undefined;
  readonly storeStarted = new Promise<void>((resolve) => {
    this.markStoreStarted = resolve;
  });

  override async store(): Promise<void> {
    this.operations.push("store:start");
    this.markStoreStarted();
    await new Promise<void>((resolve) => {
      this.releaseStore = resolve;
    });
    this.operations.push("store:end");
  }

  override async delete(): Promise<void> {
    this.operations.push("delete");
  }

  finishStore(): void {
    this.releaseStore?.();
  }
}

describe("BridgeManager", () => {
  it("uses the configured port, falls back after EADDRINUSE, exposes state, and stops cleanly", async () => {
    const attempts: number[] = [];
    const hosts: Array<string | undefined> = [];
    let pairingCodeCalls = 0;
    let stopCalls = 0;
    const manager = new BridgeManager({
      configuration: {
        bridgeUrl: "ws://localhost:48735",
        bridgePort: 48_735,
        sessionId: "session-1",
        openAllReferences: true,
      },
      secrets: new MemorySecrets(),
      createBridge: ({ host, port }) => {
        hosts.push(host);
        attempts.push(port);
        if (port === 48_735) {
          const error = new Error("address in use") as NodeJS.ErrnoException;
          error.code = "EADDRINUSE";
          throw error;
        }

        return {
          pairingStore: { revokeTokens: () => undefined },
          async start() {},
          async stop() {
            stopCalls += 1;
          },
          createPairingCode: () => ({
            code: String(123456 + pairingCodeCalls++),
            sessionId: "session-1",
            expiresAt: new Date("2026-07-10T12:02:00.000Z"),
          }),
          getUrl: () => `ws://127.0.0.1:${port}`,
        };
      },
    });

    await Promise.all([manager.start(), manager.start()]);

    expect(attempts).toEqual([48_735, 48_736]);
    expect(hosts).toEqual(["localhost", "localhost"]);
    expect(manager.snapshot()).toMatchObject({
      state: "running",
      url: "ws://127.0.0.1:48736",
      sessionId: "session-1",
      pairingCode: "123456",
    });

    await manager.start();
    expect(attempts).toEqual([48_735, 48_736]);
    expect(manager.snapshot().pairingCode).toBe("123457");

    await Promise.all([manager.stop(), manager.stop()]);
    expect(stopCalls).toBe(1);
    expect(manager.snapshot().state).toBe("stopped");
  });

  it("connects a managed bridge to its role-bound IDE client", async () => {
    const manager = new BridgeManager({
      configuration: {
        bridgeUrl: "ws://127.0.0.1:48735",
        bridgePort: 0,
        sessionId: "integration-session",
        openAllReferences: true,
      },
      secrets: new MemorySecrets(),
    });
    await manager.start();

    const snapshot = manager.snapshot();
    const token = manager.getIdeToken();
    if (!snapshot.url || !token) {
      throw new Error("Expected a managed bridge URL and IDE token");
    }

    const client = new BridgeClient({
      url: snapshot.url,
      sessionId: snapshot.sessionId,
      authToken: token,
    });
    let connected = false;
    client.onConnectionStateChanged((state) => {
      connected = state === "connected";
    });
    client.connect();

    await eventually(() => expect(connected).toBe(true));
    client.disconnect();
    await manager.stop();
  });

  it("waits for a pending stop before a new start opens another bridge", async () => {
    const attempts: number[] = [];
    let releaseStop: (() => void) | undefined;
    let markStopStarted: (() => void) | undefined;
    const stopStarted = new Promise<void>((resolve) => {
      markStopStarted = resolve;
    });
    const stopFinished = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const manager = new BridgeManager({
      configuration: {
        bridgeUrl: "ws://127.0.0.1:48735",
        bridgePort: 48_735,
        sessionId: "session-1",
        openAllReferences: true,
      },
      secrets: new MemorySecrets(),
      createBridge: ({ port }) => {
        attempts.push(port);
        return {
          pairingStore: { revokeTokens: () => undefined },
          async start() {},
          async stop() {
            markStopStarted?.();
            await stopFinished;
          },
          createPairingCode: () => ({
            code: "123456",
            sessionId: "session-1",
            expiresAt: new Date("2026-07-10T12:02:00.000Z"),
          }),
          getUrl: () => `ws://127.0.0.1:${port}`,
        };
      },
    });
    await manager.start();

    const stopping = manager.stop();
    await stopStarted;
    const restarting = manager.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attempts).toEqual([48_735]);

    releaseStop?.();
    await Promise.all([stopping, restarting]);
    expect(attempts).toEqual([48_735, 48_735]);
    expect(manager.snapshot().state).toBe("running");
    await manager.stop();
  });

  it("waits for token persistence before reset deletes stored tokens", async () => {
    const secrets = new DeferredSecrets();
    let pairingStore: PairingStore | undefined;
    const manager = new BridgeManager({
      configuration: {
        bridgeUrl: "ws://127.0.0.1:48735",
        bridgePort: 48_735,
        sessionId: "session-1",
        openAllReferences: true,
      },
      secrets,
      createBridge: (options) => {
        pairingStore = options.pairingStore;
        if (!pairingStore) {
          throw new Error("Expected PairingStore");
        }

        return {
          pairingStore,
          async start() {},
          async stop() {},
          createPairingCode: (sessionId) => pairingStore!.createPairingCode(sessionId),
          getUrl: () => "ws://127.0.0.1:48735",
        };
      },
    });
    await manager.start();

    const pairing = pairingStore!.createPairingCode("session-1");
    pairingStore!.acceptPairRequest(pairing.code, "browser");
    await secrets.storeStarted;

    const resetting = manager.resetPairing();
    await Promise.resolve();
    expect(secrets.operations).toEqual(["store:start"]);

    secrets.finishStore();
    await resetting;
    expect(secrets.operations).toEqual(["store:start", "store:end", "delete"]);
    await manager.stop();
  });

  it("keeps checking localhost ports until the next one is available", async () => {
    const attempts: number[] = [];
    const manager = new BridgeManager({
      configuration: {
        bridgeUrl: "ws://127.0.0.1:48735",
        bridgePort: 48_735,
        sessionId: "session-1",
        openAllReferences: true,
      },
      secrets: new MemorySecrets(),
      createBridge: ({ port, pairingStore }) => {
        attempts.push(port);
        if (port < 48_746) {
          const error = new Error("address in use") as NodeJS.ErrnoException;
          error.code = "EADDRINUSE";
          throw error;
        }

        return {
          pairingStore: pairingStore!,
          async start() {},
          async stop() {},
          createPairingCode: (sessionId) => pairingStore!.createPairingCode(sessionId),
          getUrl: () => `ws://127.0.0.1:${port}`,
        };
      },
    });

    await manager.start();
    expect(attempts).toHaveLength(12);
    expect(manager.snapshot().url).toBe("ws://127.0.0.1:48746");
    await manager.stop();
  });
});

async function eventually(assertion: () => void): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < 500) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw lastError;
}
