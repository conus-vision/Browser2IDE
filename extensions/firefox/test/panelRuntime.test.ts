import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RuntimeMessage = Record<string, unknown>;

const harness = vi.hoisted(() => ({
  clipboardReads: 0,
  clipboardText: "",
  messages: [] as unknown[],
  ports: [] as TestRuntimePort[],
  runtimeSend: async (_message: unknown): Promise<unknown> => undefined,
}));

vi.mock("webextension-polyfill", () => ({
  default: {
    runtime: {
      sendMessage: (message: unknown) => harness.runtimeSend(message),
      connect: ({ name }: { name: string }) => {
        const port = new TestRuntimePort(name);
        harness.ports.push(port);
        return port;
      },
    },
  },
}));

vi.mock("@browser2ide/browser-extension-core", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@browser2ide/browser-extension-core")>();
  return { ...actual, createPanelIcons: () => undefined };
});

describe("Firefox panel adapter", () => {
  let dom: FakeDom;

  beforeEach(() => {
    vi.resetModules();
    harness.clipboardReads = 0;
    harness.clipboardText = "";
    harness.messages.length = 0;
    harness.ports.length = 0;
    harness.runtimeSend = async (message) => {
      harness.messages.push(message);
      return isCommand(message) ? { ok: true } : undefined;
    };
    dom = installFakeDom();
  });

  afterEach(async () => {
    dom.window.dispatch("unload");
    await flushAsync();
    vi.unstubAllGlobals();
  });

  it("opens one channel port without reading clipboard or enabling inspect", async () => {
    await loadPanel();

    expect(harness.ports).toHaveLength(1);
    expect(harness.ports[0]?.name).toBe(
      "browser2ide.devtools.test-channel",
    );
    expect(harness.messages).toEqual([
      { type: "browser2ide.panelReady", channel: "test-channel" },
    ]);
    expect(harness.clipboardReads).toBe(0);
    expect(dom.element("inspect-mode").checked).toBe(false);
    expect(dom.element("inspect-mode").disabled).toBe(true);
  });

  it("reads clipboard only from Paste and sends the normalized link command", async () => {
    harness.clipboardText = "48735 07";
    await loadPanel();

    dom.element("paste-button").dispatch("click");
    await flushAsync();

    expect(harness.clipboardReads).toBe(1);
    expect(dom.element("link-code").value).toBe("");
    expect(harness.messages).toContainEqual({
      type: "browser2ide.linkWindow",
      channel: "test-channel",
      code: "4873507",
    });
    expect(dom.element("connection-status").value).toBe("Linking");
  });

  it("uses the lifetime port for state and inspect without a second client", async () => {
    await loadPanel();
    const port = requiredPort(0);
    port.emitMessage({ type: "browser2ide.windowState", state: "linked" });
    await flushAsync();

    const inspect = dom.element("inspect-mode");
    expect(inspect.disabled).toBe(false);
    inspect.checked = true;
    inspect.dispatch("change");
    await flushAsync();

    expect(port.sent).toHaveLength(1);
    const request = port.sent[0] as RuntimeMessage;
    expect(request).toMatchObject({
      type: "browser2ide.inspect.setEnabled",
      enabled: true,
    });
    port.emitMessage({
      type: "browser2ide.inspect.result",
      requestId: request.requestId,
      ok: true,
    });
    await flushAsync();

    expect(inspect.checked).toBe(true);
    expect(harness.ports).toHaveLength(1);
  });

  it("binds explicit Change IDE and Unlink actions", async () => {
    await loadPanel();
    requiredPort(0).emitMessage({
      type: "browser2ide.windowState",
      state: "linked",
    });
    await flushAsync();

    dom.element("change-button").dispatch("click");
    await flushAsync();
    expect(dom.element("link-controls").hidden).toBe(false);
    expect(dom.element("inspect-mode").checked).toBe(false);

    dom.element("unlink-button").dispatch("click");
    await flushAsync();
    expect(harness.messages).toContainEqual({
      type: "browser2ide.unlinkWindow",
      channel: "test-channel",
    });
  });

  it("recovers one shared port after disconnect and removes old listeners", async () => {
    await loadPanel();
    const first = requiredPort(0);
    first.emitMessage({ type: "browser2ide.windowState", state: "linked" });
    await flushAsync();

    first.disconnect();
    await flushAsync();

    expect(dom.element("inspect-mode").checked).toBe(false);
    expect(dom.element("connection-status").value).toBe(
      "Linked IDE offline",
    );
    expect(harness.messages).toEqual([
      { type: "browser2ide.panelReady", channel: "test-channel" },
      { type: "browser2ide.panelReady", channel: "test-channel" },
    ]);
    expect(harness.ports).toHaveLength(2);
    expect(first.onMessage.listenerCount).toBe(0);
    expect(requiredPort(1).onMessage.listenerCount).toBe(1);
  });

  it("disconnects the shared port on unload", async () => {
    await loadPanel();
    const port = requiredPort(0);

    dom.window.dispatch("unload");

    expect(port.disconnected).toBe(true);
    expect(port.onMessage.listenerCount).toBe(0);
  });
});

const ELEMENT_IDS = [
  "connection-status",
  "link-controls",
  "link-form",
  "link-code",
  "paste-button",
  "link-button",
  "connected-controls",
  "change-button",
  "unlink-button",
  "inspect-mode",
  "panel-error",
] as const;

class FakeElement {
  public value = "";
  public checked = false;
  public disabled = false;
  public hidden = false;
  public readonly dataset: Record<string, string> = {};
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  public addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  public dispatch(type: string): void {
    const event = { preventDefault() {} } as Event;
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

class FakeWindow {
  private readonly listeners = new Map<string, Set<() => void>>();

  public addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  public dispatch(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener();
    }
  }
}

class TestRuntimePort {
  public readonly sent: unknown[] = [];
  public disconnected = false;
  public readonly onMessage = new FakePortEvent<(message: unknown) => void>();
  public readonly onDisconnect = new FakePortEvent<() => void>();

  public constructor(public readonly name: string) {}

  public postMessage(message: unknown): void {
    if (this.disconnected) {
      throw new Error("Port is disconnected");
    }
    this.sent.push(message);
  }

  public disconnect(): void {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    this.onDisconnect.emit();
  }

  public emitMessage(message: unknown): void {
    this.onMessage.emit(message);
  }
}

class FakePortEvent<T extends (...args: never[]) => void> {
  private readonly listeners = new Set<T>();

  public get listenerCount(): number {
    return this.listeners.size;
  }

  public addListener(listener: T): void {
    this.listeners.add(listener);
  }

  public removeListener(listener: T): void {
    this.listeners.delete(listener);
  }

  public emit(...args: Parameters<T>): void {
    for (const listener of [...this.listeners]) {
      listener(...args);
    }
  }
}

interface FakeDom {
  readonly window: FakeWindow;
  element(id: string): FakeElement;
}

function installFakeDom(): FakeDom {
  const elements = new Map(
    ELEMENT_IDS.map((id) => [id, new FakeElement()] as const),
  );
  const fakeWindow = new FakeWindow();
  vi.stubGlobal("document", {
    getElementById: (id: string) => elements.get(id) ?? null,
  });
  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("location", { search: "?channel=test-channel" });
  vi.stubGlobal("navigator", {
    clipboard: {
      readText: async () => {
        harness.clipboardReads += 1;
        return harness.clipboardText;
      },
    },
  });

  return {
    window: fakeWindow,
    element(id) {
      const element = elements.get(id as (typeof ELEMENT_IDS)[number]);
      if (!element) {
        throw new Error(`Unknown fake element: ${id}`);
      }
      return element;
    },
  };
}

async function loadPanel(): Promise<void> {
  await import("../src/panel.js");
  await flushAsync();
}

function requiredPort(index: number): TestRuntimePort {
  const port = harness.ports[index];
  if (!port) {
    throw new Error(`Missing runtime port ${index}`);
  }
  return port;
}

function isCommand(message: unknown): boolean {
  return (
    isRecord(message) &&
    (message.type === "browser2ide.linkWindow" ||
      message.type === "browser2ide.unlinkWindow")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 30; index += 1) {
    await Promise.resolve();
  }
}
