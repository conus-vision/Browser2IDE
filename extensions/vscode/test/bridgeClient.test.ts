import { describe, expect, it } from "vitest";
import { BridgeClient } from "../src/bridgeClient.js";

class FakeSocket {
  onopen: (() => void) | undefined;
  onmessage: ((event: { data: string }) => void) | undefined;
  onclose: (() => void) | undefined;
  onerror: (() => void) | undefined;
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

describe("BridgeClient", () => {
  it("sends an IDE hello, publishes inspect messages, and caps reconnect delays", () => {
    const sockets: FakeSocket[] = [];
    const delays: number[] = [];
    const timers: Array<() => void> = [];
    const states: string[] = [];
    const inspected: unknown[] = [];
    const client = new BridgeClient({
      url: "ws://127.0.0.1:48735",
      sessionId: "session-1",
      authToken: "ide-token",
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimeout: (callback, delay) => {
        delays.push(delay);
        timers.push(callback);
        return timers.length;
      },
      clearTimeout: () => undefined,
    });
    client.onConnectionStateChanged((state) => states.push(state));
    client.onInspect((message) => inspected.push(message));

    client.connect();
    sockets[0].open();
    expect(JSON.parse(sockets[0].sent[0])).toMatchObject({
      type: "hello",
      sessionId: "session-1",
      authToken: "ide-token",
      source: { role: "ide" },
    });

    sockets[0].message({
      protocolVersion: 2,
      type: "inspect",
      messageId: "inspect-1",
      sessionId: "session-1",
      source: { role: "browser", id: "browser-1", metadata: {} },
      targets: [
        {
          role: "selected",
          depth: 0,
          subject: { selector: "#save", metadata: {} },
          facts: [],
          metadata: {},
        },
      ],
      context: { url: "http://localhost:3000", metadata: {} },
      metadata: {},
    });
    expect(inspected).toHaveLength(1);
    expect(states).toContain("connected");

    for (let index = 0; index < 4; index += 1) {
      sockets[index].onclose?.();
      timers.shift()?.();
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 5_000]);
  });

  it("cancels a pending reconnect when explicitly disconnected", () => {
    const socket = new FakeSocket();
    const cleared: number[] = [];
    const client = new BridgeClient({
      url: "ws://127.0.0.1:48735",
      sessionId: "session-1",
      authToken: "ide-token",
      socketFactory: () => socket,
      setTimeout: () => 42,
      clearTimeout: (timer) => cleared.push(timer as number),
    });

    client.connect();
    socket.close();
    client.disconnect();

    expect(cleared).toEqual([42]);
    expect(socket.closed).toBe(true);
  });

  it("publishes structured bridge errors to diagnostic listeners", () => {
    const socket = new FakeSocket();
    const errors: unknown[] = [];
    const client = new BridgeClient({
      url: "ws://127.0.0.1:48735",
      sessionId: "session-1",
      authToken: "ide-token",
      socketFactory: () => socket,
    });
    client.onProtocolError((error) => errors.push(error));

    client.connect();
    socket.open();
    socket.message({
      protocolVersion: 2,
      type: "error",
      messageId: "error-1",
      code: "bridge.noBrowserClient",
      message: "No browser client is connected",
      metadata: {},
    });

    expect(errors).toEqual([
      expect.objectContaining({
        code: "bridge.noBrowserClient",
        message: "No browser client is connected",
      }),
    ]);

    socket.onmessage?.({ data: "{" });
    expect(errors.at(-1)).toEqual(
      expect.objectContaining({
        code: "protocol.invalidMessage",
      }),
    );
  });

  it("disposes socket callbacks, retry timers, and listeners", () => {
    const socket = new FakeSocket();
    const cleared: number[] = [];
    const client = new BridgeClient({
      url: "ws://127.0.0.1:48735",
      sessionId: "session-1",
      authToken: "ide-token",
      socketFactory: () => socket,
      setTimeout: () => 42,
      clearTimeout: (timer) => cleared.push(timer as number),
    });
    client.onInspect(() => undefined);
    client.onConnectionStateChanged(() => undefined);

    client.connect();
    socket.close();
    client.dispose();

    expect(cleared).toEqual([42]);
    expect(socket.onopen).toBeNull();
    expect(socket.onmessage).toBeNull();
    expect(socket.onclose).toBeNull();
    expect(socket.onerror).toBeNull();
  });
});
