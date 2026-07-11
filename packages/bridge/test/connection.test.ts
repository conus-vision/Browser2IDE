import { describe, expect, it } from "vitest";
import * as registryModule from "../src/clientRegistry.js";
import type { BridgeConnection } from "../src/clientRegistry.js";

interface TestSocket {
  readyState: number;
  send(payload: string, callback: (error?: Error) => void): void;
  close(): void;
  terminate(): void;
}

type GuardedConnectionFactory = (socket: TestSocket) => BridgeConnection;

describe("guarded WebSocket connection", () => {
  it("contains sync, callback, and concurrent-close send failures", () => {
    const candidate = Reflect.get(
      registryModule,
      "createGuardedWebSocketConnection",
    ) as unknown;
    expect(candidate).toBeTypeOf("function");
    const createConnection = candidate as GuardedConnectionFactory;

    let mode: "throw" | "callback" = "throw";
    let sends = 0;
    let terminations = 0;
    const socket: TestSocket = {
      readyState: 1,
      send(_payload, callback) {
        sends += 1;
        if (mode === "throw") {
          throw new Error("synchronous send failure");
        }
        callback(new Error("asynchronous send failure"));
      },
      close() {},
      terminate() {
        terminations += 1;
      },
    };
    const connection = createConnection(socket);

    expect(() => connection.send("first")).not.toThrow();
    mode = "callback";
    expect(() => connection.send("second")).not.toThrow();
    socket.readyState = 2;
    expect(() => connection.send("closing")).not.toThrow();

    expect(sends).toBe(2);
    expect(terminations).toBe(2);
  });
});
