import { Browser2IdeMessageSchema, PROTOCOL_VERSION } from "@browser2ide/protocol";
import { describe, expect, it } from "vitest";
import {
  BrowserBridgeClient,
  InspectPublisher,
  type BrowserCredentials,
} from "../src/bridgeClient.js";

const SESSION_ID = "session-1";
const INSTANCE_ID = "2d7856f5-8218-4ba6-9f6c-7aa459333ee1";
const OTHER_INSTANCE_ID = "7bf95c9f-cf72-4831-bdf0-2a248253c617";
const AUTH_TOKEN = "a".repeat(64);
const CREDENTIALS: BrowserCredentials = {
  sessionId: SESSION_ID,
  bridgeInstanceId: INSTANCE_ID,
  authToken: AUTH_TOKEN,
};

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  readonly events: string[] = [];
  closed = false;

  send(payload: string): void {
    this.sent.push(payload);
    this.events.push(`send:${JSON.parse(payload).type as string}`);
  }

  close(): void {
    this.closed = true;
    this.events.push("close");
    this.onclose?.();
  }

  open(): void {
    this.onopen?.();
  }

  serverClose(): void {
    this.closed = true;
    this.onclose?.();
  }

  message(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

describe("BrowserBridgeClient", () => {
  it("links with a leading-zero PIN and connects only after authentication", () => {
    const harness = createHarness();

    harness.client.link("07");
    expect((harness.client as unknown as Record<string, unknown>).pair).toBeUndefined();
    harness.sockets[0].open();

    expect(JSON.parse(harness.sockets[0].sent[0])).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      type: "linkRequest",
      pin: "07",
      source: { role: "browser", id: "firefox-test" },
    });
    expect(harness.states).toEqual(["connecting", "linking"]);

    acceptLink(harness.sockets[0]);

    expect(harness.credentials).toEqual([]);
    expect(JSON.parse(harness.sockets[0].sent[1])).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      type: "hello",
      sessionId: SESSION_ID,
      bridgeInstanceId: INSTANCE_ID,
      authToken: AUTH_TOKEN,
      source: { role: "browser", id: "firefox-test" },
      capabilities: ["inspect", "link"],
    });
    expect(harness.states).not.toContain("connected");

    harness.sockets[0].message({
      protocolVersion: PROTOCOL_VERSION,
      type: "ping",
      messageId: "ping-before-auth",
      sentAt: "2026-07-10T10:00:00.000Z",
      metadata: {},
    });
    expect(harness.sockets[0].sent).toHaveLength(2);

    authenticate(harness.sockets[0]);

    expect(harness.states.at(-1)).toBe("connected");
    expect(harness.credentials).toEqual([CREDENTIALS]);
  });

  it("reconnects with saved credentials without retaining the PIN", () => {
    const harness = createHarness();

    harness.client.link("07");
    harness.sockets[0].open();
    acceptLink(harness.sockets[0]);
    authenticate(harness.sockets[0]);
    harness.sockets[0].serverClose();

    expect(harness.states.at(-1)).toBe("reconnecting");
    harness.runNextTimer();
    harness.sockets[1].open();

    const reconnectHello = JSON.parse(harness.sockets[1].sent[0]);
    expect(reconnectHello).toMatchObject({
      type: "hello",
      sessionId: SESSION_ID,
      bridgeInstanceId: INSTANCE_ID,
      authToken: AUTH_TOKEN,
    });
    expect(reconnectHello).not.toHaveProperty("pin");
    expect(harness.sockets[1].sent).toHaveLength(1);
    expect(harness.credentials).toEqual([CREDENTIALS]);
  });

  it("reuses complete credentials, then sends inspect and answers ping", () => {
    const harness = createHarness();

    harness.client.connect(CREDENTIALS);
    harness.sockets[0].open();
    expect(JSON.parse(harness.sockets[0].sent[0])).toMatchObject({
      type: "hello",
      bridgeInstanceId: INSTANCE_ID,
    });
    expect(harness.client.sendInspect(selection(".card"))).toBe(false);

    authenticate(harness.sockets[0]);
    expect(harness.client.sendInspect(selection(".card"))).toBe(true);
    const inspect = JSON.parse(harness.sockets[0].sent[1]);
    expect(Browser2IdeMessageSchema.parse(inspect)).toEqual(inspect);
    expect(inspect).toMatchObject({
      type: "inspect",
      sessionId: SESSION_ID,
      targets: [{ subject: { selector: ".card" } }],
    });

    harness.sockets[0].message({
      protocolVersion: PROTOCOL_VERSION,
      type: "ping",
      messageId: "ping-1",
      sentAt: "2026-07-10T10:00:00.000Z",
      metadata: {},
    });
    expect(JSON.parse(harness.sockets[0].sent[2])).toMatchObject({
      type: "pong",
      pingMessageId: "ping-1",
    });
  });

  it.each([
    ["session", "another-session", INSTANCE_ID],
    ["bridge instance", SESSION_ID, OTHER_INSTANCE_ID],
  ])(
    "rejects authentication for the wrong %s",
    (_identity, sessionId, bridgeInstanceId) => {
      const harness = createHarness();

      harness.client.connect(CREDENTIALS);
      harness.sockets[0].open();
      authenticate(harness.sockets[0], sessionId, bridgeInstanceId);

      expect(harness.states).not.toContain("connected");
      expect(harness.errors.at(-1)).toMatchObject({
        code: "protocol.invalidMessage",
      });
      expect(harness.sockets[0].closed).toBe(true);
      expect(harness.delays).toEqual([]);
    },
  );

  it.each(["auth.instanceChanged", "auth.tokenRejected"] as const)(
    "stops reconnect and sanitizes %s",
    (code) => {
      const harness = createHarness();

      harness.client.connect(CREDENTIALS);
      harness.sockets[0].open();
      harness.sockets[0].message({
        protocolVersion: PROTOCOL_VERSION,
        type: "error",
        messageId: "auth-error-1",
        code,
        message: `Rejected credential ${AUTH_TOKEN}`,
        metadata: {},
      });

      expect(harness.errors).toHaveLength(1);
      expect(harness.errors[0]).toMatchObject({ code });
      expect(harness.errors[0]?.message).not.toContain(AUTH_TOKEN);
      expect(harness.sockets[0].closed).toBe(true);
      expect(harness.delays).toEqual([]);
    },
  );

  it("sanitizes link errors without exposing the PIN", () => {
    const harness = createHarness();

    harness.client.link("07");
    harness.sockets[0].open();
    harness.sockets[0].message({
      protocolVersion: PROTOCOL_VERSION,
      type: "error",
      messageId: "link-error-1",
      code: "link.rejected",
      message: "Rejected PIN 07",
      metadata: {},
    });

    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0]).toMatchObject({ code: "link.rejected" });
    expect(harness.errors[0]?.message).not.toContain("07");
    expect(harness.sockets[0].closed).toBe(true);
    expect(harness.delays).toEqual([]);
  });

  it("unlinks an authenticated session before closing and clearing state", () => {
    const harness = createHarness();

    harness.client.connect(CREDENTIALS);
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);
    harness.client.unlink();

    expect(JSON.parse(harness.sockets[0].sent.at(-1) ?? "{}")).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      type: "unlink",
      sessionId: SESSION_ID,
    });
    expect(harness.sockets[0].events.slice(-2)).toEqual(["send:unlink", "close"]);
    expect(harness.states.at(-1)).toBe("disconnected");
    expect(harness.client.sendInspect(selection(".after-unlink"))).toBe(false);
    expect(harness.delays).toEqual([]);
  });

  it("preserves structured nonfatal errors for panel diagnostics", () => {
    const harness = createHarness();

    harness.client.connect(CREDENTIALS);
    harness.sockets[0].open();
    authenticate(harness.sockets[0]);
    harness.sockets[0].message({
      protocolVersion: PROTOCOL_VERSION,
      type: "error",
      messageId: "error-1",
      code: "bridge.noIdeClient",
      message: "No IDE client is connected",
      metadata: {},
    });

    expect(harness.errors.at(-1)).toMatchObject({
      code: "bridge.noIdeClient",
      message: "No IDE client is connected",
    });

    harness.sockets[0].onmessage?.({ data: "{" });
    expect(harness.errors.at(-1)).toMatchObject({
      code: "protocol.invalidMessage",
    });
  });
});

describe("InspectPublisher", () => {
  it("deduplicates selections and sends only the latest pending value per 100ms", () => {
    const timers: Array<() => void> = [];
    const delays: number[] = [];
    const cleared: number[] = [];
    const sent: string[] = [];
    let timerId = 0;
    const publisher = new InspectPublisher({
      send: (payload) => sent.push(payload.targets[0]?.subject.selector ?? ""),
      setTimeout(callback, delay) {
        timers.push(callback);
        delays.push(delay);
        return ++timerId;
      },
      clearTimeout: (timer) => cleared.push(timer as number),
    });

    publisher.publish(selection(".card"));
    publisher.publish(selection(".card"));
    publisher.publish(selection(".featured"));
    publisher.publish(selection(".layout"));
    expect(sent).toEqual([".card"]);

    timers.shift()?.();
    expect(sent).toEqual([".card", ".layout"]);
    expect(delays).toEqual([100, 100]);

    publisher.dispose();
    expect(cleared).toEqual([2]);
  });

  it("allows the same selection after a connection reset", () => {
    const sent: string[] = [];
    const publisher = new InspectPublisher({
      send: (payload) => sent.push(payload.targets[0]?.subject.selector ?? ""),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    });

    publisher.publish(selection(".card"));
    publisher.reset();
    publisher.publish(selection(".card"));

    expect(sent).toEqual([".card", ".card"]);
  });
});

function createHarness() {
  const sockets: FakeSocket[] = [];
  const states: string[] = [];
  const errors: Error[] = [];
  const credentials: BrowserCredentials[] = [];
  const delays: number[] = [];
  const timers = new Map<number, () => void>();
  let sequence = 0;
  let timerSequence = 0;
  const client = new BrowserBridgeClient({
    url: "ws://127.0.0.1:48735",
    sourceId: "firefox-test",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    messageId: () => `message-${++sequence}`,
    now: () => new Date("2026-07-11T12:00:00.000Z"),
    setTimeout: (callback, delay) => {
      delays.push(delay);
      const timerId = ++timerSequence;
      timers.set(timerId, callback);
      return timerId as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => timers.delete(timer as unknown as number),
    onCredentials: (value) => credentials.push(value),
    onStateChanged: (state) => states.push(state),
    onError: (error) => errors.push(error),
  });

  return {
    client,
    sockets,
    states,
    errors,
    credentials,
    delays,
    runNextTimer(): void {
      const entry = timers.entries().next().value as
        | [number, () => void]
        | undefined;
      if (!entry) {
        throw new Error("Expected a pending reconnect timer");
      }
      timers.delete(entry[0]);
      entry[1]();
    },
  };
}

function acceptLink(socket: FakeSocket): void {
  socket.message({
    protocolVersion: PROTOCOL_VERSION,
    type: "linkAccepted",
    messageId: "accepted-1",
    sessionId: SESSION_ID,
    bridgeInstanceId: INSTANCE_ID,
    authToken: AUTH_TOKEN,
    expiresAt: "2026-08-01T00:00:00.000Z",
    metadata: {},
  });
}

function authenticate(
  socket: FakeSocket,
  sessionId = SESSION_ID,
  bridgeInstanceId = INSTANCE_ID,
): void {
  socket.message({
    protocolVersion: PROTOCOL_VERSION,
    type: "authenticated",
    messageId: "authenticated-1",
    sessionId,
    bridgeInstanceId,
    metadata: {},
  });
}

function selection(selector: string) {
  return {
    targets: [
      {
        role: "selected" as const,
        depth: 0 as const,
        subject: { selector, metadata: {} },
        facts: [],
        metadata: {},
      },
    ],
    context: { url: "http://localhost:3000", metadata: {} },
    metadata: {},
  };
}
