import { describe, expect, it } from "vitest";
import { BridgeClient } from "../src/bridgeClient.js";
import { BridgeManager } from "../src/bridgeManager.js";

class MemorySecrets {
  async get(): Promise<string | undefined> {
    return undefined;
  }

  async store(): Promise<void> {}

  async delete(): Promise<void> {}
}

describe("BridgeManager", () => {
  it("uses the configured port, falls back after EADDRINUSE, exposes state, and stops cleanly", async () => {
    const attempts: number[] = [];
    let stopCalls = 0;
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
            code: "123456",
            sessionId: "session-1",
            expiresAt: new Date("2026-07-10T12:02:00.000Z"),
          }),
          getUrl: () => `ws://127.0.0.1:${port}`,
        };
      },
    });

    await Promise.all([manager.start(), manager.start()]);

    expect(attempts).toEqual([48_735, 48_736]);
    expect(manager.snapshot()).toMatchObject({
      state: "running",
      url: "ws://127.0.0.1:48736",
      sessionId: "session-1",
      pairingCode: "123456",
    });

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
