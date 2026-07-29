import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { PROTOCOL_VERSION, type ClientRole } from "@browser2ide/protocol";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as bridgeExports from "../src/index.js";
import { LinkAuthenticator } from "../src/linkAuthenticator.js";
import {
  BRIDGE_MAX_PAYLOAD_BYTES,
  createBridgeServer,
  type BridgeServer,
} from "../src/server.js";

const SESSION_ID = "session-1";
const INSTANCE_ID = "2d7856f5-8218-4ba6-9f6c-7aa459333ee1";
const OLD_INSTANCE_ID = "7bf95c9f-cf72-4831-bdf0-2a248253c617";
const PIN = "07";
const STARTED_AT = new Date("2026-07-09T12:00:00.000Z");

describe("bridge server link authentication", () => {
  it("links, authenticates, and unlinks only the connection token", async () => {
    const authenticator = createAuthenticator();
    const server = createBridgeServer({ port: 0, authenticator });
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      const accepted = await sendJsonAndReceive(socket, linkRequest());

      expect(accepted).toMatchObject({
        protocolVersion: PROTOCOL_VERSION,
        type: "linkAccepted",
        sessionId: SESSION_ID,
        bridgeInstanceId: INSTANCE_ID,
        expiresAt: "2026-07-10T12:00:00.000Z",
        metadata: {},
      });
      expect(accepted.authToken).toMatch(/^[a-f0-9]{64}$/);

      const authToken = readString(accepted, "authToken");
      const survivingToken = acceptedToken(authenticator);
      await expect(
        sendJsonAndReceive(socket, hello(authToken)),
      ).resolves.toMatchObject({
        protocolVersion: PROTOCOL_VERSION,
        type: "authenticated",
        sessionId: SESSION_ID,
        bridgeInstanceId: INSTANCE_ID,
        metadata: {},
      });
      expect(server.registry.countByRole("browser")).toBe(1);

      const unlinked = once(socket, "close");
      socket.send(JSON.stringify(unlink()));
      await unlinked;
      expect(server.registry.countByRole("browser")).toBe(0);

      const retry = await connect(server.getUrl());
      await expectSocketErrorAndClose(retry, hello(authToken), {
        code: "auth.tokenRejected",
      });

      const survivingSocket = await connect(server.getUrl());
      await expect(
        sendJsonAndReceive(survivingSocket, hello(survivingToken)),
      ).resolves.toMatchObject({ type: "authenticated" });
      await closeSocket(survivingSocket);
    } finally {
      await server.stop();
    }
  });

  it("returns one generic rejection for a wrong PIN", async () => {
    const server = createTestServer();
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      const error = await expectSocketErrorAndClose(
        socket,
        linkRequest("99"),
        {
          code: "link.rejected",
          message: "Link request rejected",
        },
      );
      expectLinkErrorNotToExposePin(error, "99");
    } finally {
      await server.stop();
    }
  });

  it("keeps link rate limiting global across separate sockets", async () => {
    const server = createTestServer();
    await server.start();

    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const socket = await connect(server.getUrl());
        await expectSocketErrorAndClose(
          socket,
          linkRequest("99", `link-${attempt}`),
          {
            code: "link.rejected",
            message: "Link request rejected",
          },
        );
      }

      const socket = await connect(server.getUrl());
      const error = await expectSocketErrorAndClose(
        socket,
        linkRequest("99", "link-rate-limited"),
        {
          code: "link.rateLimited",
          message: "Link request rate limited",
          details: {
            fatal: false,
            retryAt: "2026-07-09T12:01:00.000Z",
          },
        },
      );
      expectLinkErrorNotToExposePin(error, "99");
    } finally {
      await server.stop();
    }
  });

  it("rejects a second link request on the same socket", async () => {
    const server = createTestServer();
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      await expect(
        sendJsonAndReceive(socket, linkRequest(PIN, "link-first")),
      ).resolves.toMatchObject({ type: "linkAccepted" });

      await expectSocketErrorAndClose(
        socket,
        linkRequest(PIN, "link-second"),
        { code: "protocol.invalidMessage" },
      );
    } finally {
      await server.stop();
    }
  });

  it("terminates an idle socket after the handshake timeout", async () => {
    const server = createBridgeServer({ port: 0, handshakeTimeoutMs: 50 });
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      await expectSocketCloses(socket);
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      await server.stop();
    }
  });

  it("clears the handshake timeout after authentication", async () => {
    const authenticator = createAuthenticator();
    const authToken = acceptedToken(authenticator);
    const server = createBridgeServer({
      port: 0,
      authenticator,
      handshakeTimeoutMs: 50,
    });
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      await expect(
        sendJsonAndReceive(socket, hello(authToken)),
      ).resolves.toMatchObject({ type: "authenticated" });
      await delay(100);
      expect(socket.readyState).toBe(WebSocket.OPEN);
      await closeSocket(socket);
    } finally {
      await server.stop();
    }
  });

  it("drops messages queued behind unlink before they can be routed", async () => {
    const authenticator = createAuthenticator();
    const browserToken = acceptedToken(authenticator);
    const ideToken = authenticator.issueTrustedToken("ide");
    const server = createBridgeServer({ port: 0, authenticator });
    const counts: Array<{ browser: number; ide: number }> = [];
    const tokenStateAtCount: string[] = [];
    await server.start();

    try {
      const ide = await connect(server.getUrl());
      await sendJsonAndReceive(ide, hello(ideToken.value, "ide"));
      const browser = await connect(server.getUrl());
      await sendJsonAndReceive(browser, hello(browserToken));
      const countListener = server.onClientCountChanged((next) => {
        counts.push(next);
        tokenStateAtCount.push(
          authenticator.validateToken(
            SESSION_ID,
            "browser",
            browserToken,
            INSTANCE_ID,
          ),
        );
      });

      const routed: unknown[] = [];
      ide.on("message", (data) => routed.push(JSON.parse(data.toString())));
      const closed = once(browser, "close");
      browser.send(JSON.stringify(unlink()));
      browser.send(JSON.stringify(inspectMessage()));
      await closed;
      await delay(20);

      expect(routed).toEqual([]);
      expect(counts).toEqual([{ browser: 0, ide: 1 }]);
      expect(tokenStateAtCount).toEqual(["rejected"]);
      countListener.dispose();
      await closeSocket(ide);
    } finally {
      await server.stop();
    }
  });

  it("checks the bridge instance before validating the token", async () => {
    const server = createTestServer();
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      await expectSocketErrorAndClose(
        socket,
        hello("invalid-token", "browser", OLD_INSTANCE_ID),
        { code: "auth.instanceChanged" },
      );
    } finally {
      await server.stop();
    }
  });

  it("rejects an invalid token and closes the socket", async () => {
    const server = createTestServer();
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      await expectSocketErrorAndClose(socket, hello("invalid-token"), {
        code: "auth.tokenRejected",
      });
    } finally {
      await server.stop();
    }
  });

  it("rejects a valid token presented for the wrong session", async () => {
    const authenticator = createAuthenticator();
    const authToken = acceptedToken(authenticator);
    const server = createBridgeServer({ port: 0, authenticator });
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      await expectSocketErrorAndClose(
        socket,
        hello(authToken, "browser", INSTANCE_ID, "other-session"),
        { code: "auth.tokenRejected" },
      );
    } finally {
      await server.stop();
    }
  });

  it("rejects an expired token and closes the socket", async () => {
    let now = new Date(STARTED_AT);
    const authenticator = createAuthenticator({ now: () => now });
    const server = createBridgeServer({ port: 0, authenticator });
    await server.start();

    try {
      const linkSocket = await connect(server.getUrl());
      const accepted = await sendJsonAndReceive(linkSocket, linkRequest());
      const authToken = readString(accepted, "authToken");
      await closeSocket(linkSocket);

      now = new Date("2026-07-10T12:00:00.001Z");
      const helloSocket = await connect(server.getUrl());
      await expectSocketErrorAndClose(helloSocket, hello(authToken), {
        code: "auth.tokenRejected",
      });
    } finally {
      await server.stop();
    }
  });

  it("rejects a token presented by the wrong role and closes the socket", async () => {
    const server = createTestServer();
    await server.start();

    try {
      const linkSocket = await connect(server.getUrl());
      const accepted = await sendJsonAndReceive(linkSocket, linkRequest());
      const authToken = readString(accepted, "authToken");
      await closeSocket(linkSocket);

      const helloSocket = await connect(server.getUrl());
      await expectSocketErrorAndClose(
        helloSocket,
        hello(authToken, "ide"),
        { code: "auth.tokenRejected" },
      );
    } finally {
      await server.stop();
    }
  });

  it("rejects malformed clients with protocol.invalidMessage and closes", async () => {
    const server = createTestServer();
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      await expectSocketErrorAndClose(
        socket,
        {
          protocolVersion: PROTOCOL_VERSION,
          type: "unknown",
          messageId: "invalid-1",
          metadata: {},
        },
        { code: "protocol.invalidMessage" },
      );
    } finally {
      await server.stop();
    }
  });

  it("rejects routed messages before hello and closes", async () => {
    const server = createTestServer();
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      await expectSocketErrorAndClose(
        socket,
        {
          protocolVersion: PROTOCOL_VERSION,
          type: "pong",
          messageId: "pong-before-hello",
          pingMessageId: "ping-1",
          sentAt: STARTED_AT.toISOString(),
          metadata: {},
        },
        { code: "protocol.invalidMessage" },
      );
    } finally {
      await server.stop();
    }
  });

  it("rejects a second hello after registration and closes", async () => {
    const authenticator = createAuthenticator();
    const token = authenticator.issueTrustedToken("ide");
    const server = createBridgeServer({ port: 0, authenticator });
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      await expect(
        sendJsonAndReceive(socket, hello(token.value, "ide")),
      ).resolves.toMatchObject({ type: "authenticated" });

      await expectSocketErrorAndClose(socket, hello(token.value, "ide"), {
        code: "protocol.invalidMessage",
      });
    } finally {
      await server.stop();
    }
  });

  it("uses a default session and authenticator", async () => {
    const server = createBridgeServer({ port: 0 });
    expect(server.authenticator).toBeInstanceOf(LinkAuthenticator);
    expect(server.getLinkInfo()).toEqual(server.authenticator.linkInfo());
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      const accepted = await sendJsonAndReceive(
        socket,
        linkRequest(server.getLinkInfo().pin),
      );
      expect(accepted).toMatchObject({
        type: "linkAccepted",
        sessionId: "default",
        bridgeInstanceId: server.getLinkInfo().bridgeInstanceId,
      });
      await closeSocket(socket);
    } finally {
      await server.stop();
    }
  });
});

describe("bridge server client counts", () => {
  it("reports browser removal after heartbeat eviction", async () => {
    const authenticator = createAuthenticator();
    const authToken = acceptedToken(authenticator);
    const server = createBridgeServer({
      port: 0,
      authenticator,
      heartbeatIntervalMs: 10,
    });
    const counts: Array<{ browser: number; ide: number }> = [];
    server.onClientCountChanged((next) => counts.push(next));
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      await expect(
        sendJsonAndReceive(socket, hello(authToken)),
      ).resolves.toMatchObject({ type: "authenticated" });

      await eventually(() =>
        expect(counts).toEqual([
          { browser: 1, ide: 0 },
          { browser: 0, ide: 0 },
        ]),
      );
    } finally {
      await server.stop();
    }
  });

  it("reports browser registration and removal, and listener disposal works", async () => {
    const authenticator = createAuthenticator();
    const authToken = acceptedToken(authenticator);
    const server = createBridgeServer({ port: 0, authenticator });
    const counts: Array<{ browser: number; ide: number }> = [];
    const listener = server.onClientCountChanged((next) => counts.push(next));
    await server.start();

    try {
      const first = await connect(server.getUrl());
      await expect(sendJsonAndReceive(first, hello(authToken))).resolves.toMatchObject({
        type: "authenticated",
      });
      await eventually(() => expect(counts).toEqual([{ browser: 1, ide: 0 }]));

      await closeSocket(first);
      await eventually(() =>
        expect(counts).toEqual([
          { browser: 1, ide: 0 },
          { browser: 0, ide: 0 },
        ]),
      );

      listener.dispose();
      const countAtDisposal = counts.length;
      const second = await connect(server.getUrl());
      await expect(
        sendJsonAndReceive(second, hello(authToken)),
      ).resolves.toMatchObject({ type: "authenticated" });
      await closeSocket(second);
      expect(counts).toHaveLength(countAtDisposal);
    } finally {
      await server.stop();
    }
  });

  it("isolates listener errors from registration and shutdown", async () => {
    const authenticator = createAuthenticator();
    const authToken = acceptedToken(authenticator);
    const server = createBridgeServer({ port: 0, authenticator });
    const counts: Array<{ browser: number; ide: number }> = [];
    server.onClientCountChanged(() => {
      throw new Error("listener failed");
    });
    server.onClientCountChanged((next) => counts.push(next));
    await server.start();

    const socket = await connect(server.getUrl());
    await expect(sendJsonAndReceive(socket, hello(authToken))).resolves.toMatchObject({
      type: "authenticated",
    });
    expect(server.registry.countByRole("browser")).toBe(1);

    await server.stop();
    await eventually(() => expect(counts.at(-1)).toEqual({ browser: 0, ide: 0 }));
    expect(server.registry.all()).toEqual([]);
  });

  it("clears clients, revokes tokens, emits zero, and stops repeatedly", async () => {
    const authenticator = createAuthenticator();
    const authToken = acceptedToken(authenticator);
    const server = createBridgeServer({ port: 0, authenticator });
    const counts: Array<{ browser: number; ide: number }> = [];
    server.onClientCountChanged((next) => counts.push(next));
    await server.start();

    const socket = await connect(server.getUrl());
    await expect(sendJsonAndReceive(socket, hello(authToken))).resolves.toMatchObject({
      type: "authenticated",
    });
    await eventually(() => expect(server.registry.countByRole("browser")).toBe(1));

    const closed = once(socket, "close");
    await server.stop();
    await closed;
    expect(server.registry.all()).toEqual([]);
    expect(counts.at(-1)).toEqual({ browser: 0, ide: 0 });
    await server.stop();
    await server.stop();
    expect(
      authenticator.validateToken(
        SESSION_ID,
        "browser",
        authToken,
        INSTANCE_ID,
      ),
    ).toBe("rejected");
  });
});

describe("bridge server authenticated envelope identity", () => {
  it.each([
    [
      "session",
      (message: ReturnType<typeof inspectMessage>) => ({
        ...message,
        sessionId: "other-session",
      }),
    ],
    [
      "role",
      (message: ReturnType<typeof inspectMessage>) => ({
        ...message,
        source: source("simulator"),
      }),
    ],
    [
      "source id",
      (message: ReturnType<typeof inspectMessage>) => ({
        ...message,
        source: { ...message.source, id: "spoofed-browser-source" },
      }),
    ],
  ])(
    "rejects an inspect message with a mismatched authenticated %s",
    async (_field, spoof) => {
      const authenticator = createAuthenticator();
      const browserToken = acceptedToken(authenticator);
      const ideToken = authenticator.issueTrustedToken("ide");
      const server = createBridgeServer({ port: 0, authenticator });
      await server.start();

      try {
        const ide = await connect(server.getUrl());
        await sendJsonAndReceive(ide, hello(ideToken.value, "ide"));
        const browser = await connect(server.getUrl());
        await sendJsonAndReceive(browser, hello(browserToken));
        const routed: unknown[] = [];
        ide.on("message", (data) => routed.push(JSON.parse(data.toString())));

        const error = await expectSocketErrorAndClose(
          browser,
          spoof(inspectMessage()),
          {
            code: "protocol.invalidMessage",
            message: "Message does not match protocol",
          },
        );
        await delay(20);

        expect(routed).toEqual([]);
        expect(JSON.stringify(error)).not.toContain(browserToken);
        await closeSocket(ide);
      } finally {
        await server.stop();
      }
    },
  );

  it("rejects unlink for a different authenticated session without revoking the token", async () => {
    const authenticator = createAuthenticator();
    const browserToken = acceptedToken(authenticator);
    const server = createBridgeServer({ port: 0, authenticator });
    await server.start();

    try {
      const browser = await connect(server.getUrl());
      await sendJsonAndReceive(browser, hello(browserToken));

      await expectSocketErrorAndClose(
        browser,
        { ...unlink(), sessionId: "other-session" },
        {
          code: "protocol.invalidMessage",
          message: "Message does not match protocol",
        },
      );
      expect(
        authenticator.validateToken(
          SESSION_ID,
          "browser",
          browserToken,
          INSTANCE_ID,
        ),
      ).toBe("accepted");
    } finally {
      await server.stop();
    }
  });

  it("continues routing inspect messages with the authenticated identity", async () => {
    const authenticator = createAuthenticator();
    const browserToken = acceptedToken(authenticator);
    const ideToken = authenticator.issueTrustedToken("ide");
    const server = createBridgeServer({ port: 0, authenticator });
    await server.start();

    try {
      const ide = await connect(server.getUrl());
      await sendJsonAndReceive(ide, hello(ideToken.value, "ide"));
      const browser = await connect(server.getUrl());
      await sendJsonAndReceive(browser, hello(browserToken));
      const routed = nextJsonMessage(ide);

      browser.send(JSON.stringify(inspectMessage()));

      await expect(routed).resolves.toMatchObject({
        type: "inspect",
        sessionId: SESSION_ID,
        source: source("browser"),
      });
      await Promise.all([closeSocket(browser), closeSocket(ide)]);
    } finally {
      await server.stop();
    }
  });
});

describe("bridge server send safety", () => {
  it("keeps a registry connection safe after its socket closes", async () => {
    const authenticator = createAuthenticator();
    const authToken = acceptedToken(authenticator);
    const server = createBridgeServer({ port: 0, authenticator });
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      await sendJsonAndReceive(socket, hello(authToken));
      const connection = server.registry.all()[0]?.connection;
      if (!connection) {
        throw new Error("Expected registered browser connection");
      }

      await closeSocket(socket);

      expect(() => connection.send("{}")).not.toThrow();
    } finally {
      await server.stop();
    }
  });
});

describe("bridge server network policy", () => {
  it("rejects frames above the configured payload limit before protocol parsing", async () => {
    const maxPayloadBytes = 256;
    const server = createBridgeServer({ port: 0, maxPayloadBytes });
    await server.start();

    try {
      const socket = await connect(server.getUrl());
      const received: unknown[] = [];
      socket.on("message", (data) => received.push(JSON.parse(data.toString())));
      const closed = once(socket, "close");

      socket.send(Buffer.alloc(maxPayloadBytes + 1, 0x61));

      const [code] = await closed;
      expect(code).toBe(1009);
      expect(received).toEqual([]);
      expect(server.registry.all()).toEqual([]);
      expect(BRIDGE_MAX_PAYLOAD_BYTES).toBe(1024 * 1024);
    } finally {
      await server.stop();
    }
  });

  it("binds and advertises only the exact approved loopback host", async () => {
    for (const host of ["0.0.0.0", "localhost", "::1"]) {
      expect(() => createBridgeServer({ host, port: 0 })).toThrow(
        "Bridge host must be 127.0.0.1",
      );
    }

    const defaultHostServer = createBridgeServer({ port: 0 });
    await defaultHostServer.start();

    try {
      expect(defaultHostServer.getUrl()).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
      expect(defaultHostServer.getUrl()).not.toContain("0.0.0.0");
      expect(defaultHostServer.getUrl().endsWith(":0")).toBe(false);
    } finally {
      await defaultHostServer.stop();
    }
  });

  it("rejects webpage origins and allows extension and originless clients", async () => {
    const server = createBridgeServer({ port: 0 });
    await server.start();

    try {
      await expect(
        connect(server.getUrl(), "https://untrusted.example"),
      ).rejects.toThrow();

      const firefox = await connect(
        server.getUrl(),
        "moz-extension://browser2ide-test",
      );
      const chromium = await connect(
        server.getUrl(),
        "chrome-extension://browser2ide-test",
      );
      const originless = await connect(server.getUrl());
      await Promise.all([
        closeSocket(firefox),
        closeSocket(chromium),
        closeSocket(originless),
      ]);
    } finally {
      await server.stop();
    }
  });
});

describe("bridge server lifecycle", () => {
  it("stops promptly and closes active WebSocket clients", async () => {
    const server = createBridgeServer({ port: 0 });
    await server.start();
    const socket = await connect(server.getUrl());
    const closed = once(socket, "close");

    const stopPromise = server.stop();
    const outcome = await Promise.race([
      stopPromise.then(() => "stopped"),
      delay(100).then(() => "timed-out"),
    ]);

    if (outcome !== "stopped") {
      socket.terminate();
      await stopPromise;
    }

    expect(outcome).toBe("stopped");
    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("resets failed start state so a later start can succeed", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP address for blocker");
    }

    const server = createBridgeServer({ port: address.port });

    await expect(server.start()).rejects.toThrow();
    await new Promise<void>((resolve, reject) =>
      blocker.close((error) => (error ? reject(error) : resolve())),
    );

    await server.start();
    const socket = await connect(server.getUrl());
    await closeSocket(socket);
    await server.stop();
  });

  it("serializes concurrent starts so stop closes the single listener", async () => {
    const bridge = createBridgeServer({ port: 0 });

    await Promise.all([bridge.start(), bridge.start()]);
    const url = bridge.getUrl();
    expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);

    await bridge.stop();
    expect(await canConnect(url)).toBe(false);
  });

  it("stops a listener that finishes starting after stop is requested", async () => {
    const bridge = createBridgeServer({ port: 0 });

    const starting = bridge.start();
    await bridge.stop();
    await starting;
    const url = bridge.getUrl();
    const connected = await canConnect(url);
    await bridge.stop();

    expect(connected).toBe(false);
  });

  it("requires a new BridgeServer after a successful start and stop", async () => {
    const bridge = createBridgeServer({ port: 0 });

    await bridge.start();
    await bridge.stop();

    await expect(bridge.start()).rejects.toThrow(
      "BridgeServer cannot be restarted; create a new BridgeServer",
    );
  });
});

describe("bridge public surface", () => {
  it("does not export or retain the legacy link store source", () => {
    const legacyStoreName = ["Pairing", "Store"].join("");
    expect(bridgeExports).not.toHaveProperty(legacyStoreName);
    expect(existsSync(new URL("../src/pairing.ts", import.meta.url))).toBe(false);
  });

  it("does not expose a standalone bridge CLI or package bin", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      readonly bin?: unknown;
      readonly scripts?: Record<string, unknown>;
    };

    expect(existsSync(new URL("../src/cli.ts", import.meta.url))).toBe(false);
    expect(packageJson).not.toHaveProperty("bin");
    expect(packageJson.scripts).not.toHaveProperty("dev");
  });
});

function createAuthenticator(
  overrides: Partial<ConstructorParameters<typeof LinkAuthenticator>[0]> = {},
): LinkAuthenticator {
  return new LinkAuthenticator({
    sessionId: SESSION_ID,
    bridgeInstanceId: INSTANCE_ID,
    pin: PIN,
    now: () => new Date(STARTED_AT),
    ...overrides,
  });
}

function createTestServer(): BridgeServer {
  return createBridgeServer({ port: 0, authenticator: createAuthenticator() });
}

function acceptedToken(authenticator: LinkAuthenticator): string {
  const result = authenticator.attemptLink(PIN, "browser");
  if (!("accepted" in result)) {
    throw new Error("Expected test link attempt to be accepted");
  }
  return result.accepted.authToken.value;
}

function source(role: ClientRole) {
  return { role, id: `${role}-source`, metadata: {} };
}

function linkRequest(pin = PIN, messageId = "link-1") {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "linkRequest",
    messageId,
    pin,
    source: source("browser"),
    metadata: {},
  };
}

function hello(
  authToken: string,
  role: ClientRole = "browser",
  bridgeInstanceId = INSTANCE_ID,
  sessionId = SESSION_ID,
) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "hello",
    messageId: `hello-${role}`,
    sessionId,
    authToken,
    bridgeInstanceId,
    source: source(role),
    capabilities: role === "ide" ? ["references"] : ["inspect"],
    metadata: {},
  };
}

function unlink() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "unlink",
    messageId: "unlink-1",
    sessionId: SESSION_ID,
    metadata: {},
  };
}

function inspectMessage() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "inspect",
    messageId: "inspect-after-unlink",
    sessionId: SESSION_ID,
    source: source("browser"),
    targets: [
      {
        role: "selected",
        depth: 0,
        subject: { selector: "#submit", metadata: {} },
        facts: [],
        metadata: {},
      },
    ],
    context: { url: "http://localhost:3000", metadata: {} },
    metadata: {},
  };
}

async function connect(url: string, origin?: string): Promise<WebSocket> {
  const socket = new WebSocket(url, origin ? { origin } : undefined);
  await once(socket, "open");
  return socket;
}

async function sendJsonAndReceive(
  socket: WebSocket,
  message: unknown,
): Promise<Record<string, unknown>> {
  const response = nextJsonMessage(socket);
  socket.send(JSON.stringify(message));
  return response;
}

async function nextJsonMessage(
  socket: WebSocket,
): Promise<Record<string, unknown>> {
  const [data] = await once(socket, "message");
  return JSON.parse(data.toString()) as Record<string, unknown>;
}

async function expectSocketErrorAndClose(
  socket: WebSocket,
  message: unknown,
  expected: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = nextJsonMessage(socket);
  const closed = expectSocketCloses(socket);
  socket.send(JSON.stringify(message));
  const parsed = await response;
  expect(parsed).toMatchObject({
    protocolVersion: PROTOCOL_VERSION,
    type: "error",
    metadata: {},
    ...expected,
  });
  await closed;
  return parsed;
}

async function expectSocketCloses(socket: WebSocket): Promise<void> {
  const outcome = await Promise.race([
    once(socket, "close").then(() => "closed" as const),
    delay(500).then(() => "timed-out" as const),
  ]);
  expect(outcome).toBe("closed");
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  const closed = once(socket, "close");
  socket.close();
  await closed;
}

function readString(message: Record<string, unknown>, key: string): string {
  const value = message[key];
  if (typeof value !== "string") {
    throw new Error(`Expected ${key} to be a string`);
  }
  return value;
}

function expectLinkErrorNotToExposePin(
  message: Record<string, unknown>,
  pin: string,
): void {
  expect(message.message).not.toContain(pin);
  expect(JSON.stringify(message.details)).not.toContain(pin);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function canConnect(url: string): Promise<boolean> {
  let socket: WebSocket | undefined;

  try {
    socket = await connect(url);
    return true;
  } catch {
    return false;
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await closeSocket(socket);
    }
  }
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
      await delay(10);
    }
  }

  throw lastError;
}
