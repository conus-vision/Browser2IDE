import { describe, expect, it } from "vitest";
import {
  BackgroundInspectCoordinator,
  attachBackgroundInspectSession,
} from "../src/backgroundInspectSession.js";
import {
  INSPECT_PORT_NAME,
  type InspectPortRequest,
} from "../src/inspectPortProtocol.js";

describe("background inspect session", () => {
  it("disables the tab after its port disconnects during a pending enable", async () => {
    const enable = deferred<void>();
    const calls: unknown[] = [];
    const port = new FakePort(INSPECT_PORT_NAME);
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript(details) {
        calls.push(["inject", details]);
      },
      async sendTabMessage(tabId, message) {
        calls.push(["tab", tabId, message]);
        if (
          isRecord(message) &&
          message.type === "enableInspectMode"
        ) {
          await enable.promise;
        }
      },
    });
    const session = attachBackgroundInspectSession(port, coordinator);

    port.emitMessage(request("enable", true));
    await flushAsync();
    port.emitDisconnect();
    enable.resolve();
    await session.whenIdle();

    expect(calls).toEqual([
      [
        "inject",
        { target: { tabId: 17 }, files: ["dist/contentScript.js"] },
      ],
      ["tab", 17, { type: "enableInspectMode" }],
      ["tab", 17, { type: "disableInspectMode" }],
    ]);
    expect(port.sent).toEqual([]);
  });

  it("serializes enable and disable requests on the owning port", async () => {
    const enable = deferred<void>();
    const calls: unknown[] = [];
    const port = new FakePort(INSPECT_PORT_NAME);
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript() {
        calls.push("inject");
      },
      async sendTabMessage(_tabId, message) {
        calls.push(message);
        if (
          isRecord(message) &&
          message.type === "enableInspectMode"
        ) {
          await enable.promise;
        }
      },
    });
    const session = attachBackgroundInspectSession(port, coordinator);

    port.emitMessage(request("enable", true));
    await flushAsync();
    port.emitMessage(request("disable", false));
    enable.resolve();
    await session.whenIdle();

    expect(calls).toEqual([
      "inject",
      { type: "enableInspectMode" },
      { type: "disableInspectMode" },
    ]);
    expect(port.sent).toEqual([
      {
        type: "browser2ide.inspect.result",
        requestId: "enable",
        ok: true,
      },
      {
        type: "browser2ide.inspect.result",
        requestId: "disable",
        ok: true,
      },
    ]);
  });

  it("does not let an old port disable a newer owner for the same tab", async () => {
    const firstEnable = deferred<void>();
    const calls: unknown[] = [];
    let enableCount = 0;
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript() {
        calls.push("inject");
      },
      async sendTabMessage(_tabId, message) {
        calls.push(message);
        if (
          isRecord(message) &&
          message.type === "enableInspectMode"
        ) {
          enableCount += 1;
          if (enableCount === 1) {
            await firstEnable.promise;
          }
        }
      },
    });
    const oldPort = new FakePort(INSPECT_PORT_NAME);
    const newPort = new FakePort(INSPECT_PORT_NAME);
    attachBackgroundInspectSession(oldPort, coordinator);
    attachBackgroundInspectSession(newPort, coordinator);

    oldPort.emitMessage(request("old", true));
    await flushAsync();
    newPort.emitMessage(request("new", true));
    oldPort.emitDisconnect();
    firstEnable.resolve();
    await coordinator.whenIdle(17);

    expect(calls).toEqual([
      "inject",
      { type: "enableInspectMode" },
      "inject",
      { type: "enableInspectMode" },
    ]);
    expect(newPort.sent).toEqual([
      {
        type: "browser2ide.inspect.result",
        requestId: "new",
        ok: true,
      },
    ]);
  });

  it("lets the same owner retry a failed disable", async () => {
    const calls: unknown[] = [];
    let rejectNextDisable = true;
    const coordinator = new BackgroundInspectCoordinator({
      async executeScript() {},
      async sendTabMessage(_tabId, message) {
        calls.push(message);
        if (
          rejectNextDisable &&
          isRecord(message) &&
          message.type === "disableInspectMode"
        ) {
          rejectNextDisable = false;
          throw new Error("Content script did not answer");
        }
      },
    });
    const port = new FakePort(INSPECT_PORT_NAME);
    const session = attachBackgroundInspectSession(port, coordinator);

    port.emitMessage(request("enable", true));
    await session.whenIdle();
    port.emitMessage(request("disable-1", false));
    await session.whenIdle();
    port.emitMessage(request("disable-2", false));
    await session.whenIdle();
    await flushAsync();

    expect(calls).toEqual([
      { type: "enableInspectMode" },
      { type: "disableInspectMode" },
      { type: "disableInspectMode" },
    ]);
    expect(port.sent).toEqual([
      {
        type: "browser2ide.inspect.result",
        requestId: "enable",
        ok: true,
      },
      {
        type: "browser2ide.inspect.result",
        requestId: "disable-1",
        ok: false,
        error: "Inspect mode update failed",
      },
      {
        type: "browser2ide.inspect.result",
        requestId: "disable-2",
        ok: true,
      },
    ]);
  });
});

class FakePort {
  public readonly sent: unknown[] = [];
  public readonly onMessage = new FakeEvent<(message: unknown) => void>();
  public readonly onDisconnect = new FakeEvent<() => void>();

  public constructor(public readonly name: string) {}

  public postMessage(message: unknown): void {
    this.sent.push(message);
  }

  public emitMessage(message: unknown): void {
    this.onMessage.emit(message);
  }

  public emitDisconnect(): void {
    this.onDisconnect.emit();
  }
}

class FakeEvent<T extends (...args: never[]) => void> {
  private readonly listeners = new Set<T>();

  public addListener(listener: T): void {
    this.listeners.add(listener);
  }

  public removeListener(listener: T): void {
    this.listeners.delete(listener);
  }

  public emit(...args: Parameters<T>): void {
    for (const listener of this.listeners) {
      listener(...args);
    }
  }
}

function request(requestId: string, enabled: boolean): InspectPortRequest {
  return {
    type: "browser2ide.inspect.setEnabled",
    requestId,
    tabId: 17,
    enabled,
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
