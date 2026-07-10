#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import WebSocket, { type RawData } from "ws";
import {
  Browser2IdeMessageSchema,
  InspectMessageSchema,
  PROTOCOL_VERSION,
  type Browser2IdeMessage,
  type InspectMessage,
  type PairAcceptedMessage,
} from "@browser2ide/protocol";

const DEFAULT_URL = "ws://127.0.0.1:48735";
const DEFAULT_SOURCE_ID = "browser2ide-simulator";
const DEFAULT_TIMEOUT_MS = 2_000;

interface BuildInspectOptions {
  readonly sessionId: string;
  readonly sourceId: string;
}

export interface SendInspectOptions {
  readonly url?: string;
  readonly pairingCode?: string;
  readonly authToken?: string;
  readonly sessionId?: string;
  readonly fixture: string;
  readonly sourceId?: string;
  readonly timeoutMs?: number;
}

export interface ParsedSendArgs extends SendInspectOptions {
  readonly command: "send";
  readonly url: string;
  readonly sourceId: string;
}

export function buildInspectMessage(
  fixture: unknown,
  options: BuildInspectOptions,
): InspectMessage {
  if (!isRecord(fixture)) {
    throw new Error("Inspect fixture must contain a JSON object");
  }

  return InspectMessageSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    type: "inspect",
    messageId: randomUUID(),
    sessionId: options.sessionId,
    source: {
      role: "simulator",
      id: options.sourceId,
      metadata: {},
    },
    targets: fixture.targets,
    context: fixture.context,
    metadata: fixture.metadata ?? {},
  });
}

export function parseSendArgs(args: string[]): ParsedSendArgs {
  const [command, ...rawFlags] = args;
  if (command !== "send") {
    throw new Error("Expected command: send");
  }
  const flags = rawFlags[0] === "--" ? rawFlags.slice(1) : rawFlags;

  const values = new Map<string, string>();
  const supportedFlags = new Set([
    "--url",
    "--pairing-code",
    "--auth-token",
    "--session-id",
    "--fixture",
    "--source-id",
  ]);

  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1];

    if (!flag || !supportedFlags.has(flag)) {
      throw new Error(`Unknown option: ${flag ?? "<missing>"}`);
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    if (values.has(flag)) {
      throw new Error(`Option supplied more than once: ${flag}`);
    }

    values.set(flag, value);
  }

  const pairingCode = values.get("--pairing-code");
  const authToken = values.get("--auth-token");
  const sessionId = values.get("--session-id");
  const fixture = values.get("--fixture");
  const url = values.get("--url") ?? DEFAULT_URL;
  const sourceId = values.get("--source-id") ?? DEFAULT_SOURCE_ID;

  if (!fixture) {
    throw new Error("--fixture is required");
  }
  if (pairingCode && authToken) {
    throw new Error("Use either --pairing-code or --auth-token, not both");
  }
  if (!pairingCode && !authToken) {
    throw new Error("--pairing-code or --auth-token is required");
  }
  if (authToken && !sessionId) {
    throw new Error("--session-id is required when --auth-token is supplied");
  }

  assertWebSocketUrl(url);

  return {
    command: "send",
    url,
    pairingCode,
    authToken,
    sessionId,
    fixture,
    sourceId,
  };
}

export async function sendInspect(
  options: SendInspectOptions,
): Promise<InspectMessage> {
  validateSendOptions(options);

  const url = options.url ?? DEFAULT_URL;
  const sourceId = options.sourceId ?? DEFAULT_SOURCE_ID;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fixture = await loadFixture(options.fixture);
  const socket = await connect(url, timeoutMs);

  try {
    const credentials = options.pairingCode
      ? await pair(socket, options.pairingCode, sourceId, timeoutMs)
      : {
          sessionId: options.sessionId as string,
          authToken: options.authToken as string,
        };

    await sendProtocolMessage(socket, {
      protocolVersion: PROTOCOL_VERSION,
      type: "hello",
      messageId: randomUUID(),
      sessionId: credentials.sessionId,
      authToken: credentials.authToken,
      source: {
        role: "simulator",
        id: sourceId,
        metadata: {},
      },
      capabilities: ["inspect"],
      metadata: {},
    });

    const inspect = buildInspectMessage(fixture, {
      sessionId: credentials.sessionId,
      sourceId,
    });
    await sendProtocolMessage(socket, inspect);
    return inspect;
  } finally {
    await closeSocket(socket, timeoutMs);
  }
}

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  const options = parseSendArgs(args);
  const inspect = await sendInspect(options);
  console.log(
    `Sent inspect for ${inspect.targets[0]?.subject.selector ?? "selected element"} in session ${inspect.sessionId}`,
  );
}

async function pair(
  socket: WebSocket,
  pairingCode: string,
  sourceId: string,
  timeoutMs: number,
): Promise<{ sessionId: string; authToken: string }> {
  const accepted = waitForMessage(
    socket,
    (message): message is PairAcceptedMessage => message.type === "pairAccepted",
    timeoutMs,
  );

  await sendProtocolMessage(socket, {
    protocolVersion: PROTOCOL_VERSION,
    type: "pairRequest",
    messageId: randomUUID(),
    pairingCode,
    source: {
      role: "simulator",
      id: sourceId,
      metadata: {},
    },
    metadata: {},
  });

  const response = await accepted;
  return {
    sessionId: response.sessionId,
    authToken: response.authToken,
  };
}

async function loadFixture(name: string): Promise<unknown> {
  const normalizedName = name.endsWith(".json") ? name.slice(0, -5) : name;
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(normalizedName)) {
    throw new Error(`Invalid fixture name: ${name}`);
  }

  const fixtureUrl = new URL(`../fixtures/${normalizedName}.json`, import.meta.url);
  try {
    return JSON.parse(await readFile(fixtureUrl, "utf8"));
  } catch (error) {
    throw new Error(`Could not load fixture: ${name}`, { cause: error });
  }
}

function validateSendOptions(options: SendInspectOptions): void {
  const hasPairingCode = Boolean(options.pairingCode);
  const hasAuthToken = Boolean(options.authToken);

  if (hasPairingCode === hasAuthToken) {
    throw new Error("Provide exactly one of pairingCode or authToken");
  }
  if (hasAuthToken && !options.sessionId) {
    throw new Error("sessionId is required when authToken is supplied");
  }
  if (!options.fixture) {
    throw new Error("fixture is required");
  }
  if (options.timeoutMs !== undefined && options.timeoutMs <= 0) {
    throw new Error("timeoutMs must be greater than zero");
  }

  assertWebSocketUrl(options.url ?? DEFAULT_URL);
}

function assertWebSocketUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid WebSocket URL: ${value}`);
  }

  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`Invalid WebSocket URL: ${value}`);
  }
}

function connect(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      cleanup();
      socket.terminate();
      reject(new Error(`Timed out connecting to ${url}`));
    }, timeoutMs);
    const onOpen = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (error: Error) => {
      cleanup();
      socket.terminate();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("open", onOpen);
      socket.off("error", onError);
    };

    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

function sendProtocolMessage(
  socket: WebSocket,
  message: Browser2IdeMessage,
): Promise<void> {
  const payload = JSON.stringify(Browser2IdeMessageSchema.parse(message));

  return new Promise((resolve, reject) => {
    socket.send(payload, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function waitForMessage<T extends Browser2IdeMessage>(
  socket: WebSocket,
  predicate: (message: Browser2IdeMessage) => message is T,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for bridge response"));
    }, timeoutMs);
    const onMessage = (data: RawData) => {
      let message: Browser2IdeMessage;
      try {
        message = Browser2IdeMessageSchema.parse(JSON.parse(data.toString()));
      } catch (error) {
        cleanup();
        reject(new Error("Bridge sent an invalid protocol message", { cause: error }));
        return;
      }

      if (message.type === "error") {
        cleanup();
        reject(new Error(`${message.code}: ${message.message}`));
        return;
      }
      if (predicate(message)) {
        cleanup();
        resolve(message);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Bridge closed before sending a response"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };

    socket.on("message", onMessage);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function closeSocket(socket: WebSocket, timeoutMs: number): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  if (socket.readyState !== WebSocket.OPEN) {
    socket.terminate();
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      socket.terminate();
      resolve();
    }, timeoutMs);
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.close();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
