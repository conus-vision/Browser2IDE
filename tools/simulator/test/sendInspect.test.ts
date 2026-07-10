import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  createAuthorizedToken,
  createBridgeServer,
  PairingStore,
} from "@browser2ide/bridge";
import {
  Browser2IdeMessageSchema,
  type Browser2IdeMessage,
  type PairAcceptedMessage,
} from "@browser2ide/protocol";
import inspectCardFixture from "../fixtures/inspect-card.json";
import {
  buildInspectMessage,
  parseSendArgs,
  sendInspect,
} from "../src/sendInspect.js";

describe("inspect-card fixture", () => {
  it("builds a valid inspect message with the required card facts", () => {
    const message = buildInspectMessage(inspectCardFixture, {
      sessionId: "session-1",
      sourceId: "simulator-test",
    });

    expect(Browser2IdeMessageSchema.parse(message)).toEqual(message);
    expect(message).toMatchObject({
      protocolVersion: 2,
      type: "inspect",
      sessionId: "session-1",
      source: { role: "simulator", id: "simulator-test", metadata: {} },
      targets: [
        {
          role: "selected",
          depth: 0,
          subject: {
            selector: "div#hero.card.featured",
            metadata: { kind: "dom-node" },
          },
        },
      ],
      context: { url: "http://localhost:3000/", metadata: { viewport: "desktop" } },
    });
    expect(message.targets[0]?.subject.text).toBeUndefined();

    expect(message.targets[0]?.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "css-rule",
          selector: ".card",
          metadata: { sourceUrl: "/dist/app.css" },
        }),
        expect.objectContaining({
          type: "css-rule",
          selector: ".featured",
          metadata: { sourceUrl: "/dist/app.css" },
        }),
        expect.objectContaining({
          type: "css-rule",
          selector: ".card",
          metadata: {
            status: "external",
            sourceUrl: "https://cdn.jsdelivr.net/npm/bootstrap/dist/css/bootstrap.css",
          },
        }),
      ]),
    );
  });
});

describe("sendInspect CLI parsing", () => {
  it("requires a session id when auth-token mode is used", () => {
    expect(() =>
      parseSendArgs(["send", "--auth-token", "token-1", "--fixture", "inspect-card"]),
    ).toThrow("--session-id is required when --auth-token is supplied");
  });

  it("parses the documented pairing-code command", () => {
    expect(
      parseSendArgs([
        "send",
        "--",
        "--pairing-code",
        "123456",
        "--fixture",
        "inspect-card",
      ]),
    ).toMatchObject({
      command: "send",
      pairingCode: "123456",
      fixture: "inspect-card",
      url: "ws://127.0.0.1:48735",
    });
  });
});

describe("sendInspect", () => {
  it("pairs with an in-process bridge and routes inspect to an IDE client", async () => {
    const bridge = createBridgeServer({ port: 0, sessionId: "session-1" });
    await bridge.start();

    let ideSocket: WebSocket | undefined;
    try {
      const pairing = bridge.createPairingCode("session-1");
      ideSocket = await connect(bridge.getUrl());
      const ideAccepted = await pairAndHelloIde(ideSocket, pairing.code);
      const simulatorPairing = bridge.createPairingCode("session-1");
      const routedMessage = nextProtocolMessage(ideSocket, (message) => {
        return message.type === "inspect";
      });

      await sendInspect({
        url: bridge.getUrl(),
        pairingCode: simulatorPairing.code,
        fixture: "inspect-card",
        sourceId: "simulator-integration",
      });

      const routed = await routedMessage;

      expect(routed).toMatchObject({
        type: "inspect",
        sessionId: ideAccepted.sessionId,
        source: { role: "simulator", id: "simulator-integration" },
        targets: [{ subject: { selector: "div#hero.card.featured" } }],
      });
    } finally {
      if (ideSocket && ideSocket.readyState !== WebSocket.CLOSED) {
        ideSocket.close();
        await onceWithTimeout(ideSocket, "close", 250).catch(() => {
          ideSocket?.terminate();
        });
      }
      await bridge.stop();
    }
  });

  it("uses an existing token when auth-token mode is selected", async () => {
    const simulatorToken = createAuthorizedToken("session-1", "simulator");
    const bridge = createBridgeServer({
      port: 0,
      sessionId: "session-1",
      pairingStore: new PairingStore({ authorizedTokens: [simulatorToken] }),
    });
    await bridge.start();

    let ideSocket: WebSocket | undefined;
    try {
      const pairing = bridge.createPairingCode("session-1");
      ideSocket = await connect(bridge.getUrl());
      const ideAccepted = await pairAndHelloIde(ideSocket, pairing.code);
      const routedMessage = nextProtocolMessage(ideSocket, (message) => {
        return message.type === "inspect";
      });

      await sendInspect({
        url: bridge.getUrl(),
        authToken: simulatorToken.value,
        sessionId: simulatorToken.sessionId,
        fixture: "inspect-card",
        sourceId: "simulator-auth",
      });

      const routed = await routedMessage;

      expect(routed).toMatchObject({
        type: "inspect",
        sessionId: "session-1",
        source: { role: "simulator", id: "simulator-auth" },
      });
    } finally {
      if (ideSocket && ideSocket.readyState !== WebSocket.CLOSED) {
        ideSocket.close();
        await onceWithTimeout(ideSocket, "close", 250).catch(() => {
          ideSocket?.terminate();
        });
      }
      await bridge.stop();
    }
  });
});

async function pairAndHelloIde(
  socket: WebSocket,
  pairingCode: string,
): Promise<PairAcceptedMessage> {
  socket.send(
    JSON.stringify({
      protocolVersion: 2,
      type: "pairRequest",
      messageId: randomUUID(),
      pairingCode,
      source: { role: "ide", id: "ide-test", metadata: {} },
      metadata: {},
    }),
  );

  const accepted = (await nextProtocolMessage(
    socket,
    (message) => message.type === "pairAccepted",
  )) as PairAcceptedMessage;

  socket.send(
    JSON.stringify({
      protocolVersion: 2,
      type: "hello",
      messageId: randomUUID(),
      sessionId: accepted.sessionId,
      authToken: accepted.authToken,
      source: { role: "ide", id: "ide-test", metadata: {} },
      capabilities: ["references"],
      metadata: {},
    }),
  );

  return accepted;
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  try {
    await onceWithTimeout(socket, "open", 500);
    return socket;
  } catch (error) {
    socket.terminate();
    throw error;
  }
}

async function nextProtocolMessage(
  socket: WebSocket,
  predicate: (message: Browser2IdeMessage) => boolean,
): Promise<Browser2IdeMessage> {
  const timeoutAt = Date.now() + 500;

  while (Date.now() < timeoutAt) {
    const remaining = timeoutAt - Date.now();
    const [data] = await onceWithTimeout(socket, "message", remaining);
    const message = Browser2IdeMessageSchema.parse(JSON.parse(data.toString()));
    if (message.type === "ping") {
      socket.send(
        JSON.stringify({
          protocolVersion: 2,
          type: "pong",
          messageId: randomUUID(),
          pingMessageId: message.messageId,
          sentAt: new Date().toISOString(),
          metadata: {},
        }),
      );
      continue;
    }
    if (predicate(message)) {
      return message;
    }
  }

  throw new Error("Timed out waiting for protocol message");
}

function onceWithTimeout(
  socket: WebSocket,
  event: "open" | "message" | "close",
  timeoutMs: number,
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const onEvent = (...args: any[]) => {
      cleanup();
      resolve(args);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off(event, onEvent);
      socket.off("error", onError);
    };

    socket.once(event, onEvent);
    socket.once("error", onError);
  });
}
