import { describe, expect, it } from "vitest";
import { Browser2IdeMessageSchema } from "@browser2ide/protocol";
import {
  BrowserBridgeClient,
  InspectPublisher,
} from "../src/bridgeClient.js";

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  open(): void {
    this.onopen?.();
  }

  message(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

describe("BrowserBridgeClient", () => {
  it("pairs as browser, publishes credentials, then authenticates with hello", () => {
    const socket = new FakeSocket();
    const credentials: unknown[] = [];
    const states: string[] = [];
    let sequence = 0;
    const client = new BrowserBridgeClient({
      url: "ws://127.0.0.1:48735",
      sourceId: "firefox-test",
      socketFactory: () => socket,
      messageId: () => `message-${++sequence}`,
      onCredentials: (value) => credentials.push(value),
      onStateChanged: (state) => states.push(state),
    });

    client.pair("123456");
    socket.open();
    expect(socket.onopen).toBeNull();
    expect(JSON.parse(socket.sent[0])).toMatchObject({
      type: "pairRequest",
      pairingCode: "123456",
      source: { role: "browser", id: "firefox-test" },
    });

    socket.message({
      protocolVersion: 2,
      type: "pairAccepted",
      messageId: "accepted-1",
      sessionId: "session-1",
      authToken: "browser-token",
      expiresAt: "2026-08-01T00:00:00.000Z",
      metadata: {},
    });

    expect(credentials).toEqual([
      { sessionId: "session-1", authToken: "browser-token" },
    ]);
    expect(JSON.parse(socket.sent[1])).toMatchObject({
      type: "hello",
      sessionId: "session-1",
      authToken: "browser-token",
      source: { role: "browser", id: "firefox-test" },
      capabilities: ["inspect", "pairing"],
    });
    expect(states).toEqual(["connecting", "pairing", "connected"]);
  });

  it("reuses stored credentials, sends inspect, and answers ping", () => {
    const socket = new FakeSocket();
    let sequence = 0;
    const client = new BrowserBridgeClient({
      url: "ws://127.0.0.1:48735",
      sourceId: "firefox-test",
      socketFactory: () => socket,
      messageId: () => `message-${++sequence}`,
    });

    client.connect({ sessionId: "session-1", authToken: "browser-token" });
    socket.open();
    expect(JSON.parse(socket.sent[0]).type).toBe("hello");

    client.sendInspect(selection(".card"));
    const inspect = JSON.parse(socket.sent[1]);
    expect(Browser2IdeMessageSchema.parse(inspect)).toEqual(inspect);
    expect(inspect).toMatchObject({
      type: "inspect",
      sessionId: "session-1",
      targets: [{ subject: { selector: ".card" } }],
    });

    socket.message({
      protocolVersion: 2,
      type: "ping",
      messageId: "ping-1",
      sentAt: "2026-07-10T10:00:00.000Z",
      metadata: {},
    });
    expect(JSON.parse(socket.sent[2])).toMatchObject({
      type: "pong",
      pingMessageId: "ping-1",
    });

    client.disconnect();
    expect(socket.closed).toBe(true);
    expect(socket.onmessage).toBeNull();
  });

  it("preserves structured bridge error codes for panel diagnostics", () => {
    const socket = new FakeSocket();
    const errors: Error[] = [];
    const client = new BrowserBridgeClient({
      url: "ws://127.0.0.1:48735",
      sourceId: "firefox-test",
      socketFactory: () => socket,
      onError: (error) => errors.push(error),
    });

    client.connect({ sessionId: "session-1", authToken: "browser-token" });
    socket.open();
    socket.message({
      protocolVersion: 2,
      type: "error",
      messageId: "error-1",
      code: "bridge.noIdeClient",
      message: "No IDE client is connected",
      metadata: {},
    });

    expect(errors).toEqual([
      expect.objectContaining({
        code: "bridge.noIdeClient",
        message: "No IDE client is connected",
      }),
    ]);

    socket.onmessage?.({ data: "{" });
    expect(errors.at(-1)).toEqual(
      expect.objectContaining({ code: "protocol.invalidMessage" }),
    );
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
