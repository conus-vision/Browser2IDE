import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createAuthorizedToken, tokensEqual } from "../src/auth.js";
import { PairingStore } from "../src/pairing.js";
import { createBridgeServer } from "../src/server.js";

describe("bridge auth", () => {
  it("compares equal tokens in constant time", () => {
    const token = createAuthorizedToken("session-1");
    const differentToken = `${token.value.slice(0, -1)}${
      token.value.endsWith("0") ? "1" : "0"
    }`;

    expect(tokensEqual(token.value, token.value)).toBe(true);
    expect(tokensEqual(token.value, differentToken)).toBe(false);
    expect(tokensEqual(token.value, `${token.value}extra`)).toBe(false);
  });

  it("creates random 30-day session tokens", () => {
    const now = new Date("2026-07-09T12:00:00.000Z");

    const first = createAuthorizedToken("session-1", "browser", now);
    const second = createAuthorizedToken("session-1", "browser", now);

    expect(first.sessionId).toBe("session-1");
    expect(first.role).toBe("browser");
    expect(first.value).toMatch(/^[a-f0-9]{64}$/);
    expect(second.value).not.toBe(first.value);
    expect(first.expiresAt.toISOString()).toBe("2026-08-08T12:00:00.000Z");
  });

  it("returns pairAccepted and accepts hello with a valid session token", async () => {
    const server = createBridgeServer({ port: 0, sessionId: "session-1" });
    await server.start();

    try {
      const pairing = server.createPairingCode();
      const pairingSocket = await connect(server.getUrl());

      pairingSocket.send(
        JSON.stringify({
          protocolVersion: 2,
          type: "pairRequest",
          messageId: "pair-1",
          pairingCode: pairing.code,
          source: { role: "browser", id: "browser-source", metadata: {} },
          metadata: {},
        }),
      );

      const accepted = await nextJsonMessage(pairingSocket);
      expect(accepted).toMatchObject({
        protocolVersion: 2,
        type: "pairAccepted",
        sessionId: "session-1",
        metadata: {},
      });
      expect(accepted.authToken).toMatch(/^[a-f0-9]{64}$/);

      const helloSocket = await connect(server.getUrl());
      helloSocket.send(
        JSON.stringify({
          protocolVersion: 2,
          type: "hello",
          messageId: "hello-1",
          sessionId: accepted.sessionId,
          authToken: accepted.authToken,
          source: { role: "browser", id: "browser-source", metadata: {} },
          capabilities: ["inspect"],
          metadata: {},
        }),
      );

      await eventually(() =>
        expect(server.registry.findBySessionAndRole("session-1", "browser")).toHaveLength(
          1,
        ),
      );

      pairingSocket.close();
      helloSocket.close();
    } finally {
      await server.stop();
    }
  });

  it("returns distinct structured errors for invalid and expired pairing codes", async () => {
    let now = new Date("2026-07-09T12:00:00.000Z");
    const pairingStore = new PairingStore({ now: () => now });
    const server = createBridgeServer({ port: 0, pairingStore });
    await server.start();

    try {
      const invalidSocket = await connect(server.getUrl());
      invalidSocket.send(
        JSON.stringify({
          protocolVersion: 2,
          type: "pairRequest",
          messageId: "pair-invalid",
          pairingCode: "000000-invalid",
          source: { role: "browser", id: "browser-source", metadata: {} },
          metadata: {},
        }),
      );
      await expect(nextJsonMessage(invalidSocket)).resolves.toMatchObject({
        type: "error",
        code: "pairing.invalidCode",
      });

      const pairing = server.createPairingCode("session-1");
      now = new Date("2026-07-09T12:02:00.001Z");
      const expiredSocket = await connect(server.getUrl());
      expiredSocket.send(
        JSON.stringify({
          protocolVersion: 2,
          type: "pairRequest",
          messageId: "pair-expired",
          pairingCode: pairing.code,
          source: { role: "browser", id: "browser-source", metadata: {} },
          metadata: {},
        }),
      );
      await expect(nextJsonMessage(expiredSocket)).resolves.toMatchObject({
        type: "error",
        code: "pairing.expiredCode",
      });

      invalidSocket.close();
      expiredSocket.close();
    } finally {
      await server.stop();
    }
  });

  it("returns protocol.invalidMessage and closes malformed clients", async () => {
    const server = createBridgeServer({ port: 0 });
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      const closed = once(socket, "close");
      socket.send(
        JSON.stringify({
          protocolVersion: 2,
          type: "unknown",
          messageId: "invalid-1",
          metadata: {},
        }),
      );

      await expect(nextJsonMessage(socket)).resolves.toMatchObject({
        type: "error",
        code: "protocol.invalidMessage",
      });
      await closed;
    } finally {
      await server.stop();
    }
  });

  it("rejects invalid session tokens with an error message and closes the socket", async () => {
    const server = createBridgeServer({ port: 0, sessionId: "session-1" });
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      const closed = once(socket, "close");

      socket.send(
        JSON.stringify({
          protocolVersion: 2,
          type: "hello",
          messageId: "hello-invalid",
          sessionId: "session-1",
          authToken: "invalid",
          source: { role: "ide", id: "ide-source", metadata: {} },
          capabilities: ["references"],
          metadata: {},
        }),
      );

      const error = await nextJsonMessage(socket);
      expect(error).toMatchObject({
        protocolVersion: 2,
        type: "error",
        code: "auth.invalidSessionToken",
        message: "Invalid session token",
        metadata: {},
      });
      await closed;
    } finally {
      await server.stop();
    }
  });

  it("rejects hello when a token is presented by the wrong role", async () => {
    const server = createBridgeServer({ port: 0, sessionId: "session-1" });
    await server.start();

    try {
      const pairing = server.createPairingCode();
      const pairingSocket = await connect(server.getUrl());
      pairingSocket.send(
        JSON.stringify({
          protocolVersion: 2,
          type: "pairRequest",
          messageId: "pair-role-1",
          pairingCode: pairing.code,
          source: { role: "browser", id: "browser-source", metadata: {} },
          metadata: {},
        }),
      );
      const accepted = await nextJsonMessage(pairingSocket);
      const helloSocket = await connect(server.getUrl());
      const closed = once(helloSocket, "close");

      helloSocket.send(
        JSON.stringify({
          protocolVersion: 2,
          type: "hello",
          messageId: "hello-wrong-role",
          sessionId: "session-1",
          authToken: accepted.authToken,
          source: { role: "ide", id: "ide-source", metadata: {} },
          capabilities: ["references"],
          metadata: {},
        }),
      );

      await expect(nextJsonMessage(helloSocket)).resolves.toMatchObject({
        type: "error",
        code: "auth.invalidSessionToken",
      });
      await closed;
      pairingSocket.close();
    } finally {
      await server.stop();
    }
  });

  it("does not advertise 0.0.0.0 unless an explicit host option is provided", async () => {
    const defaultHostServer = createBridgeServer({ port: 0 });
    await defaultHostServer.start();

    try {
      expect(defaultHostServer.getUrl()).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
      expect(defaultHostServer.getUrl()).not.toContain("0.0.0.0");
      expect(defaultHostServer.getUrl().endsWith(":0")).toBe(false);
    } finally {
      await defaultHostServer.stop();
    }

    const explicitHostServer = createBridgeServer({ host: "0.0.0.0", port: 0 });
    await explicitHostServer.start();

    try {
      expect(explicitHostServer.getUrl()).toMatch(/^ws:\/\/0\.0\.0\.0:\d+$/);
    } finally {
      await explicitHostServer.stop();
    }
  });

  it("rejects webpage origins while allowing extension and originless clients", async () => {
    const server = createBridgeServer({ port: 0 });
    await server.start();

    try {
      await expect(
        connect(server.getUrl(), "https://untrusted.example"),
      ).rejects.toThrow();

      const extensionSocket = await connect(
        server.getUrl(),
        "moz-extension://browser2ide-test",
      );
      const originlessSocket = await connect(server.getUrl());
      extensionSocket.close();
      originlessSocket.close();
    } finally {
      await server.stop();
    }
  });
});

async function connect(url: string, origin?: string): Promise<WebSocket> {
  const socket = new WebSocket(url, origin ? { origin } : undefined);
  await once(socket, "open");
  return socket;
}

async function nextJsonMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  const [data] = await once(socket, "message");
  return JSON.parse(data.toString()) as Record<string, unknown>;
}

function once(socket: WebSocket, event: "open" | "message" | "close"): Promise<any[]> {
  return new Promise((resolve, reject) => {
    socket.once(event, (...args) => resolve(args));
    socket.once("error", reject);
  });
}

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
