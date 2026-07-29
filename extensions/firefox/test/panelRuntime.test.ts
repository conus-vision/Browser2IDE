import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

interface FakeClient {
  readonly url: string;
  readonly active: boolean;
  readonly credentials?: unknown;
  readonly pin?: string;
  readonly unlinkCalls: number;
  emitProtocolError(code: string, message: string): void;
  emitState(state: string): void;
}

type RuntimeListener = (message: unknown) => void;

const harness = vi.hoisted(() => ({
  clients: [] as FakeClient[],
  runtimeListeners: [] as RuntimeListener[],
  storageGet: async (_keys: string[]): Promise<Record<string, unknown>> => ({}),
  storageSet: async (_values: Record<string, unknown>): Promise<void> => {},
  storageRemove: async (_keys: string[]): Promise<void> => {},
  runtimeSend: async (_message: unknown): Promise<unknown> => undefined,
}));

vi.mock("webextension-polyfill", () => ({
  default: {
    storage: {
      local: {
        get: (keys: string[]) => harness.storageGet(keys),
        set: (values: Record<string, unknown>) => harness.storageSet(values),
        remove: (keys: string[]) => harness.storageRemove(keys),
      },
    },
    runtime: {
      sendMessage: (message: unknown) => harness.runtimeSend(message),
      onMessage: {
        addListener: (listener: RuntimeListener) => {
          harness.runtimeListeners.push(listener);
        },
        removeListener: (listener: RuntimeListener) => {
          const index = harness.runtimeListeners.indexOf(listener);
          if (index >= 0) {
            harness.runtimeListeners.splice(index, 1);
          }
        },
      },
    },
  },
}));

vi.mock("../src/bridgeClient.js", () => {
  class FakeBrowserProtocolError extends Error {
    public constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }

  class FakeBrowserBridgeClient implements FakeClient {
    public readonly url: string;
    public credentials: unknown;
    public pin: string | undefined;
    public unlinkCalls = 0;
    private stopped = true;

    public constructor(
      private readonly options: {
        readonly url: string;
        readonly onStateChanged?: (state: string) => void;
        readonly onError?: (error: Error) => void;
      },
    ) {
      this.url = options.url;
      harness.clients.push(this);
    }

    public get active(): boolean {
      return !this.stopped;
    }

    public link(pin: string): void {
      this.pin = pin;
      this.stopped = false;
    }

    public connect(credentials: unknown): void {
      this.credentials = credentials;
      this.stopped = false;
    }

    public disconnect(): void {
      this.stopped = true;
    }

    public unlink(): void {
      this.unlinkCalls += 1;
      this.stopped = true;
    }

    public sendInspect(): boolean {
      return false;
    }

    public emitProtocolError(code: string, message: string): void {
      this.options.onError?.(new FakeBrowserProtocolError(code, message));
    }

    public emitState(state: string): void {
      this.options.onStateChanged?.(state);
    }
  }

  class FakeInspectPublisher {
    public publish(): void {}
    public reset(): void {}
    public dispose(): void {}
  }

  return {
    BrowserBridgeClient: FakeBrowserBridgeClient,
    BrowserProtocolError: FakeBrowserProtocolError,
    InspectPublisher: FakeInspectPublisher,
  };
});

describe("Firefox panel lifecycle", () => {
  let dom: FakeDom;

  beforeEach(() => {
    vi.resetModules();
    harness.clients.length = 0;
    harness.runtimeListeners.length = 0;
    harness.storageGet = async () => ({});
    harness.storageSet = async () => {};
    harness.storageRemove = async () => {};
    harness.runtimeSend = async () => undefined;
    dom = installFakeDom();
  });

  afterEach(async () => {
    dom.window.dispatch("unload");
    await flushAsync();
    vi.unstubAllGlobals();
  });

  it("serializes double Link without leaving an orphan client", async () => {
    const removals: Deferred<void>[] = [];
    harness.storageRemove = () => {
      const pending = deferred<void>();
      removals.push(pending);
      return pending.promise;
    };
    await loadSettledPanel();

    submitLink(dom, "4873507");
    await flushAsync();
    submitLink(dom, "4873608");
    await flushAsync();

    removals[0]?.resolve();
    await flushAsync();
    removals[1]?.resolve();
    await flushAsync();

    expect(activeClients()).toHaveLength(1);
    expect(activeClients()[0]).toMatchObject({
      url: "ws://127.0.0.1:48736",
      pin: "08",
    });
  });

  it("serializes Link followed by Unlink without leaving a client", async () => {
    const removals: Deferred<void>[] = [];
    harness.storageRemove = () => {
      const pending = deferred<void>();
      removals.push(pending);
      return pending.promise;
    };
    await loadSettledPanel();

    submitLink(dom, "4873507");
    await flushAsync();
    dom.element("unlink-button").dispatch("click");
    await flushAsync();

    removals[0]?.resolve();
    await flushAsync();
    removals[1]?.resolve();
    await flushAsync();

    expect(activeClients()).toEqual([]);
  });

  it("lets an explicit Link supersede an overlapping initialize", async () => {
    const stored = deferred<Record<string, unknown>>();
    harness.storageGet = () => stored.promise;

    await import("../src/panel.js");
    submitLink(dom, "4873608");
    await flushAsync();

    stored.resolve(storedLink("48735"));
    await flushAsync();

    expect(activeClients()).toHaveLength(1);
    expect(activeClients()[0]).toMatchObject({
      url: "ws://127.0.0.1:48736",
      pin: "08",
    });
  });

  it("reconnects only the saved endpoint and complete credentials", async () => {
    harness.storageGet = async () => storedLink("48735");

    await loadSettledPanel();

    expect(activeClients()).toHaveLength(1);
    expect(activeClients()[0]).toMatchObject({
      url: "ws://127.0.0.1:48735",
      credentials: {
        sessionId: "saved-session",
        bridgeInstanceId:
          "2d7856f5-8218-4ba6-9f6c-7aa459333ee1",
        authToken: "saved-token",
      },
    });
  });

  it("blocks all controls while a lifecycle operation is pending", async () => {
    const removal = deferred<void>();
    harness.storageRemove = () => removal.promise;
    await loadSettledPanel();

    submitLink(dom, "4873507");
    await flushAsync();

    expect(dom.element("link-button").disabled).toBe(true);
    expect(dom.element("unlink-button").disabled).toBe(true);
    expect(dom.element("inspect-mode").disabled).toBe(true);

    removal.resolve();
    await flushAsync();
  });

  it("does not let stale auth invalidation remove a newer Link", async () => {
    const remoteDisables: Deferred<unknown>[] = [];
    harness.runtimeSend = (message) => {
      if (
        isRecord(message) &&
        message.type === "disableInspectMode"
      ) {
        const pending = deferred<unknown>();
        remoteDisables.push(pending);
        return pending.promise;
      }
      return Promise.resolve(undefined);
    };
    await loadSettledPanel();

    submitLink(dom, "4873507");
    await flushAsync();
    const first = harness.clients[0];
    expect(first).toBeDefined();

    notifyRuntime({
      type: "browser2ide.inspectedTab",
      channel: "test-channel",
      tabId: 12,
    });
    first?.emitState("connected");
    dom.element("inspect-mode").checked = true;
    dom.element("inspect-mode").dispatch("change");
    await flushAsync();

    first?.emitProtocolError(
      "auth.tokenRejected",
      "Rejected 4873507/browser-token",
    );
    await flushAsync();
    submitLink(dom, "4873608");
    await flushAsync();

    for (const pending of remoteDisables.slice(1)) {
      pending.resolve(undefined);
    }
    await flushAsync();
    remoteDisables[0]?.resolve(undefined);
    await flushAsync();

    const latest = harness.clients.find(
      (candidate) => candidate.url === "ws://127.0.0.1:48736",
    );
    expect(latest).toBeDefined();
    latest?.emitState("connected");

    expect(dom.element("connection-status").value).toBe("Linked");
    expect(activeClients()).toEqual([latest]);
  });

  it("prevents pending initialize from creating a client after unload", async () => {
    const stored = deferred<Record<string, unknown>>();
    harness.storageGet = () => stored.promise;

    await import("../src/panel.js");
    dom.window.dispatch("unload");
    stored.resolve(storedLink("48735"));
    await flushAsync();

    expect(activeClients()).toEqual([]);
  });

  it("prevents pending Link from creating a client after unload", async () => {
    const removal = deferred<void>();
    harness.storageRemove = () => removal.promise;
    await loadSettledPanel();

    submitLink(dom, "4873507");
    await flushAsync();
    dom.window.dispatch("unload");
    removal.resolve();
    await flushAsync();

    expect(activeClients()).toEqual([]);
  });
});

const ELEMENT_IDS = [
  "link-form",
  "link-code",
  "link-button",
  "unlink-button",
  "inspect-mode",
  "connection-status",
  "selected-summary",
  "link-status",
  "linked-endpoint",
  "linked-session",
  "bridge-instance",
  "last-message",
  "last-error",
  "matched-facts",
  "inaccessible-stylesheets",
] as const;

class FakeElement {
  public value = "";
  public checked = false;
  public disabled = false;
  public hidden = false;
  public readonly dataset: Record<string, string> = {};
  private readonly listeners = new Map<string, ((event: FakeEvent) => void)[]>();

  public addEventListener(
    type: string,
    listener: (event: FakeEvent) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  public dispatch(type: string): void {
    const event = { preventDefault() {} };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

interface FakeEvent {
  preventDefault(): void;
}

class FakeWindow {
  private readonly listeners = new Map<string, (() => void)[]>();

  public addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  public dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
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
  const linkDetails = [new FakeElement(), new FakeElement()];
  const fakeWindow = new FakeWindow();
  const fakeDocument = {
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelectorAll: () => linkDetails,
  };

  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("location", { search: "?channel=test-channel" });
  vi.stubGlobal("crypto", { randomUUID: () => "panel-source-id" });

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

async function loadSettledPanel(): Promise<void> {
  await import("../src/panel.js");
  await flushAsync();
}

function submitLink(dom: FakeDom, code: string): void {
  const input = dom.element("link-code");
  input.value = code;
  input.dispatch("input");
  dom.element("link-form").dispatch("submit");
}

function notifyRuntime(message: unknown): void {
  for (const listener of [...harness.runtimeListeners]) {
    listener(message);
  }
}

function activeClients(): FakeClient[] {
  return harness.clients.filter((candidate) => candidate.active);
}

function storedLink(port: string): Record<string, unknown> {
  return {
    browser2ideBridgeUrl: `ws://127.0.0.1:${port}`,
    browser2ideSessionId: "saved-session",
    browser2ideBridgeInstanceId:
      "2d7856f5-8218-4ba6-9f6c-7aa459333ee1",
    browser2ideAuthToken: "saved-token",
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
