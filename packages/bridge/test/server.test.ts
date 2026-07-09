import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createBridgeServer } from "../src/server.js";

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
    socket.close();
    await once(socket, "close");
    await server.stop();
  });
});

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await once(socket, "open");
  return socket;
}

function once(socket: WebSocket, event: "open" | "close"): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    socket.once(event, (...args) => resolve(args));
    socket.once("error", reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
