import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createAuthorizedToken, tokensEqual } from "../src/auth.js";
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

    const first = createAuthorizedToken("session-1", now);
    const second = createAuthorizedToken("session-1", now);

    expect(first.sessionId).toBe("session-1");
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
          protocolVersion: 1,
          type: "pairRequest",
          messageId: "pair-1",
          pairingCode: pairing.code,
          source: { role: "browser", id: "browser-source", metadata: {} },
          metadata: {},
        }),
      );

      const accepted = await nextJsonMessage(pairingSocket);
      expect(accepted).toMatchObject({
        protocolVersion: 1,
        type: "pairAccepted",
        sessionId: "session-1",
        metadata: {},
      });
      expect(accepted.authToken).toMatch(/^[a-f0-9]{64}$/);

      const helloSocket = await connect(server.getUrl());
      helloSocket.send(
        JSON.stringify({
          protocolVersion: 1,
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

  it("rejects invalid session tokens with an error message and closes the socket", async () => {
    const server = createBridgeServer({ port: 0, sessionId: "session-1" });
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      const closed = once(socket, "close");

      socket.send(
        JSON.stringify({
          protocolVersion: 1,
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
        protocolVersion: 1,
        type: "error",
        code: "UNAUTHORIZED",
        message: "Invalid session token",
        metadata: {},
      });
      await closed;
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
});

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
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
