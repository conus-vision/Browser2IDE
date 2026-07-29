import type { ClientSource } from "@browser2ide/protocol";
import { describe, expect, it } from "vitest";
import {
  BrowserProtocolError,
  BrowserWindowLinkStore,
  WindowConnectionCoordinator,
  type BrowserBridgeClientOptions,
  type BrowserConnectionState,
  type BrowserCredentials,
  type BrowserWindowLink,
  type InspectPayload,
  type SessionStorage,
} from "../src/index.js";

const INSTANCE_A = "2d7856f5-8218-4ba6-9f6c-7aa459333ee1";
const INSTANCE_B = "e76bb54e-f1fc-4d76-844c-554a283b5291";
const AUTH_TOKEN_A = "a".repeat(32);
const AUTH_TOKEN_B = "b".repeat(32);

describe("WindowConnectionCoordinator", () => {
  it("opens one client for all panels in one browser window", async () => {
    const harness = coordinatorHarness();
    await harness.coordinator.linkWindow(
      10,
      "4873507",
      browserSource("window-10"),
    );

    const first = harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "p1",
    });
    const second = harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 102,
      sourceId: "p2",
    });
    await harness.flush();

    expect(harness.createdClients).toHaveLength(1);
    first.dispose();
    expect(harness.createdClients[0].disconnectCalls).toBe(0);
    second.dispose();
    expect(harness.createdClients[0].disconnectCalls).toBe(1);
  });

  it("keeps clients and endpoints isolated between browser windows", async () => {
    const harness = coordinatorHarness();

    const first = await harness.link(10, "4873507");
    const second = await harness.link(20, "4873608");

    expect(harness.createdClients).toHaveLength(2);
    expect(first).not.toBe(second);
    expect(first.url).toBe("ws://127.0.0.1:48735");
    expect(second.url).toBe("ws://127.0.0.1:48736");
    expect(first.sourceId).toBe("window-10");
    expect(second.sourceId).toBe("window-20");
  });

  it("loads a saved window link on the first registration", async () => {
    const harness = coordinatorHarness();
    const saved = windowLink();
    await harness.store.save(10, saved);
    const states: string[] = [];

    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
      onStateChanged: (state) => states.push(state),
    });
    expect(harness.createdClients).toHaveLength(0);
    await harness.flush();

    expect(harness.createdClients).toHaveLength(1);
    expect(harness.createdClients[0]).toMatchObject({
      url: saved.url,
      sourceId: "panel-101",
      connectCalls: [credentialsFor(saved)],
    });
    expect(states).toContain("linking");

    harness.createdClients[0].emitState("connected");
    expect(harness.coordinator.state(10)).toBe("linked");
  });

  it.each(["auth.instanceChanged", "auth.tokenRejected"] as const)(
    "deletes the mapping and never retries after %s",
    async (code) => {
      const harness = coordinatorHarness();
      const client = await harness.link(10, "4873507");
      harness.coordinator.registerPanel({
        windowId: 10,
        tabId: 101,
        sourceId: "panel-101",
      });
      await harness.authenticate(client, windowLink());

      client.emitState("error");
      client.emitError(new BrowserProtocolError(code, "sanitized"));
      client.emitState("disconnected");
      await harness.flush();

      await expect(harness.store.load(10)).resolves.toBeUndefined();
      expect(harness.coordinator.state(10)).toBe("offline");
      expect(client.disconnectCalls).toBe(1);
      expect(harness.createdClients).toHaveLength(1);
      expect(harness.timers.pendingCount()).toBe(0);
    },
  );

  it("does not let stale auth cleanup overwrite a new link state", async () => {
    const storage = new RejectableAuthRemovalStorage();
    const harness = coordinatorHarness(storage);
    const first = await harness.link(10, "4873507");
    await harness.authenticate(first, windowLink());

    first.emitState("error");
    first.emitError(
      new BrowserProtocolError("auth.tokenRejected", "sanitized"),
    );
    await storage.waitForAuthRemoval();

    const relinking = harness.coordinator.linkWindow(
      10,
      "4873608",
      browserSource("window-10-new"),
    );
    expect(harness.coordinator.state(10)).toBe("linking");
    storage.rejectAuthRemoval();
    await relinking;

    expect(harness.coordinator.state(10)).toBe("linking");
    expect(harness.createdClients).toHaveLength(2);
    expect(harness.createdClients[1].url).toBe("ws://127.0.0.1:48736");
  });

  it("maps protocol rate limiting without scheduling a retry", async () => {
    const harness = coordinatorHarness();
    const client = await harness.link(10, "4873507");
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });

    client.emitState("error");
    client.emitError(
      new BrowserProtocolError("link.rateLimited", "sanitized"),
    );

    expect(harness.coordinator.state(10)).toBe("rateLimited");
    expect(harness.timers.pendingCount()).toBe(0);
  });

  it("owns capped reconnect timing and cancels it with the final panel", async () => {
    const harness = coordinatorHarness();
    const client = await harness.link(10, "4873507");
    const registration = harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    const saved = windowLink();
    await harness.authenticate(client, saved);

    client.emitState("disconnected");
    expect(harness.coordinator.state(10)).toBe("reconnecting");
    expect(harness.timers.delays).toEqual([1_000]);

    for (const expectedDelay of [2_000, 4_000, 5_000, 5_000]) {
      harness.timers.runNext();
      expect(client.connectCalls.at(-1)).toEqual(credentialsFor(saved));
      client.emitState("disconnected");
      expect(harness.timers.delays.at(-1)).toBe(expectedDelay);
    }

    expect(harness.createdClients).toHaveLength(1);
    registration.dispose();
    expect(client.disconnectCalls).toBe(1);
    expect(harness.timers.pendingCount()).toBe(0);
    expect(() => harness.timers.runNext()).toThrow("Expected a pending timer");
  });

  it("revokes and deletes links on unlink and browser-window removal", async () => {
    const harness = coordinatorHarness();
    const first = await harness.link(10, "4873507");
    const second = await harness.link(20, "4873608");
    await harness.authenticate(first, windowLink());
    await harness.authenticate(
      second,
      windowLink({
        port: 48_736,
        sessionId: "session-20",
        bridgeInstanceId: INSTANCE_B,
        authToken: AUTH_TOKEN_B,
      }),
    );

    await harness.coordinator.unlinkWindow(10);
    await harness.coordinator.removeWindow(20);

    expect(first.unlinkCalls).toBe(1);
    expect(second.unlinkCalls).toBe(1);
    await expect(harness.store.load(10)).resolves.toBeUndefined();
    await expect(harness.store.load(20)).resolves.toBeUndefined();
    expect(harness.coordinator.state(10)).toBe("notLinked");
    expect(harness.coordinator.state(20)).toBe("notLinked");
  });

  it("preserves each registered panel source for simultaneous publishes", async () => {
    const harness = coordinatorHarness();
    const client = await harness.link(10, "4873507");
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 102,
      sourceId: "panel-102",
    });
    await harness.authenticate(client, windowLink());
    const payload = selection(".same-selection");

    expect(
      harness.coordinator.publishInspect(10, "panel-101", payload),
    ).toBe(true);
    expect(
      harness.coordinator.publishInspect(10, "panel-102", payload),
    ).toBe(true);
    expect(client.inspectCalls.map(({ sourceId }) => sourceId)).toEqual([
      "panel-101",
      "panel-102",
    ]);
    expect(
      harness.coordinator.publishInspect(10, "not-registered", payload),
    ).toBe(false);
    expect(
      harness.coordinator.publishInspect(20, "panel-101", payload),
    ).toBe(false);

    client.emitState("disconnected");
    expect(
      harness.coordinator.publishInspect(10, "panel-101", payload),
    ).toBe(false);
  });

  it("does not connect a saved mapping whose load finishes after unlink", async () => {
    const storage = new DeferredGetSessionStorage();
    const harness = coordinatorHarness(storage);
    const registration = harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    await Promise.resolve();
    expect(storage.getCalls).toBe(1);

    const unlinking = harness.coordinator.unlinkWindow(10);
    storage.resolveGet({ "browser2ide.windowLink.10": windowLink() });
    await unlinking;
    await harness.flush();

    expect(harness.createdClients).toHaveLength(0);
    expect(storage.values).not.toHaveProperty("browser2ide.windowLink.10");
    expect(harness.coordinator.state(10)).toBe("notLinked");
    registration.dispose();
  });

  it.each(["unlink", "dispose"] as const)(
    "ignores stale credentials and reconnect callbacks after %s",
    async (operation) => {
      const harness = coordinatorHarness();
      const client = await harness.link(10, "4873507");
      harness.coordinator.registerPanel({
        windowId: 10,
        tabId: 101,
        sourceId: "panel-101",
      });

      if (operation === "unlink") {
        await harness.coordinator.unlinkWindow(10);
      } else {
        harness.coordinator.dispose();
      }
      client.emitCredentials(credentialsFor(windowLink()));
      client.emitState("connected");
      client.emitState("disconnected");
      await harness.flush();

      await expect(harness.store.load(10)).resolves.toBeUndefined();
      expect(harness.createdClients).toHaveLength(1);
      expect(harness.timers.pendingCount()).toBe(0);
    },
  );

  it("ignores a saved mapping whose load finishes after disposal", async () => {
    const storage = new DeferredGetSessionStorage();
    const harness = coordinatorHarness(storage);
    harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    await Promise.resolve();
    expect(storage.getCalls).toBe(1);

    harness.coordinator.dispose();
    storage.resolveGet({ "browser2ide.windowLink.10": windowLink() });
    await harness.flush();

    expect(harness.createdClients).toHaveLength(0);
    expect(harness.timers.pendingCount()).toBe(0);
  });

  it("returns inert handles for invalid and duplicate registrations", async () => {
    const storage = new MemorySessionStorage();
    const harness = coordinatorHarness(storage);
    const invalid = [
      { windowId: -1, tabId: 101, sourceId: "negative-window" },
      { windowId: 10, tabId: 1.5, sourceId: "fractional-tab" },
      { windowId: 10, tabId: 101, sourceId: "" },
    ];

    for (const registration of invalid) {
      const handle = harness.coordinator.registerPanel(registration);
      expect(() => handle.dispose()).not.toThrow();
      expect(() => handle.dispose()).not.toThrow();
    }

    const valid = harness.coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    const duplicateSource = harness.coordinator.registerPanel({
      windowId: 20,
      tabId: 201,
      sourceId: "panel-101",
    });
    const duplicateTab = harness.coordinator.registerPanel({
      windowId: 20,
      tabId: 101,
      sourceId: "panel-201",
    });
    await harness.flush();

    duplicateSource.dispose();
    duplicateTab.dispose();
    expect(storage.getCalls).toBe(1);
    expect(harness.createdClients).toHaveLength(0);
    valid.dispose();
  });
});

class FakeWindowClient {
  public readonly url: string;
  public readonly sourceId: string;
  public readonly autoReconnect: boolean | undefined;
  public readonly linkCalls: string[] = [];
  public readonly connectCalls: BrowserCredentials[] = [];
  public readonly inspectCalls: Array<{
    payload: InspectPayload;
    sourceId: string | undefined;
  }> = [];
  public disconnectCalls = 0;
  public unlinkCalls = 0;
  public inspectResult = true;

  public constructor(private readonly options: BrowserBridgeClientOptions) {
    this.url = options.url;
    this.sourceId = options.sourceId;
    this.autoReconnect = options.autoReconnect;
  }

  public link(pin: string): void {
    this.linkCalls.push(pin);
  }

  public connect(credentials: BrowserCredentials): void {
    this.connectCalls.push(credentials);
  }

  public disconnect(): void {
    this.disconnectCalls += 1;
  }

  public unlink(): void {
    this.unlinkCalls += 1;
  }

  public sendInspect(payload: InspectPayload, sourceId?: string): boolean {
    this.inspectCalls.push({ payload, sourceId });
    return this.inspectResult;
  }

  public emitCredentials(credentials: BrowserCredentials): void {
    this.options.onCredentials?.(credentials);
  }

  public emitState(state: BrowserConnectionState): void {
    this.options.onStateChanged?.(state);
  }

  public emitError(error: Error): void {
    this.options.onError?.(error);
  }
}

class MemorySessionStorage implements SessionStorage {
  public readonly values: Record<string, unknown>;
  public readonly removals: string[] = [];
  public getCalls = 0;

  public constructor(initial: Record<string, unknown> = {}) {
    this.values = { ...initial };
  }

  public async get(key: string): Promise<Record<string, unknown>> {
    this.getCalls += 1;
    return Object.hasOwn(this.values, key) ? { [key]: this.values[key] } : {};
  }

  public async set(values: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, values);
  }

  public async remove(key: string): Promise<void> {
    this.removals.push(key);
    delete this.values[key];
  }
}

class DeferredGetSessionStorage extends MemorySessionStorage {
  private resolvePendingGet:
    | ((values: Record<string, unknown>) => void)
    | undefined;
  private readonly pendingGet = new Promise<Record<string, unknown>>(
    (resolve) => {
      this.resolvePendingGet = resolve;
    },
  );

  public override async get(_key: string): Promise<Record<string, unknown>> {
    this.getCalls += 1;
    const values = await this.pendingGet;
    Object.assign(this.values, values);
    return values;
  }

  public resolveGet(values: Record<string, unknown>): void {
    this.resolvePendingGet?.(values);
    this.resolvePendingGet = undefined;
  }
}

class RejectableAuthRemovalStorage extends MemorySessionStorage {
  private removeCalls = 0;
  private readonly authRemovalStarted = deferred<void>();
  private readonly authRemoval = deferred<void>();

  public override async remove(key: string): Promise<void> {
    this.removeCalls += 1;
    if (this.removeCalls === 2) {
      this.authRemovalStarted.resolve();
      await this.authRemoval.promise;
    }
    await super.remove(key);
  }

  public async waitForAuthRemoval(): Promise<void> {
    await this.authRemovalStarted.promise;
  }

  public rejectAuthRemoval(): void {
    this.authRemoval.reject(new Error("session storage unavailable"));
  }
}

function coordinatorHarness(storage: SessionStorage = new MemorySessionStorage()) {
  const createdClients: FakeWindowClient[] = [];
  const store = new BrowserWindowLinkStore(storage);
  const timers = manualTimers();
  const coordinator = new WindowConnectionCoordinator({
    store,
    createClient: (options) => {
      const client = new FakeWindowClient(options);
      createdClients.push(client);
      return client;
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  return {
    coordinator,
    createdClients,
    store,
    timers,
    async link(windowId: number, code: string): Promise<FakeWindowClient> {
      const before = createdClients.length;
      await coordinator.linkWindow(
        windowId,
        code,
        browserSource(`window-${windowId}`),
      );
      const client = createdClients[before];
      if (!client) {
        throw new Error("Expected linkWindow to create a client");
      }
      return client;
    },
    async authenticate(
      client: FakeWindowClient,
      saved: BrowserWindowLink,
    ): Promise<void> {
      client.emitCredentials(credentialsFor(saved));
      client.emitState("connected");
      await flushMicrotasks();
      expect(coordinator.state(windowIdFor(saved))).toBe("linked");
    },
    flush: flushMicrotasks,
  };
}

function manualTimers() {
  let nextId = 0;
  const callbacks = new Map<number, () => void>();
  const delays: number[] = [];
  const cleared: number[] = [];

  return {
    delays,
    cleared,
    setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
      const id = ++nextId;
      callbacks.set(id, callback);
      delays.push(delay);
      return id as ReturnType<typeof setTimeout>;
    },
    clearTimeout(timer: ReturnType<typeof setTimeout>): void {
      const id = timer as unknown as number;
      cleared.push(id);
      callbacks.delete(id);
    },
    runNext(): void {
      const entry = callbacks.entries().next().value as
        | [number, () => void]
        | undefined;
      if (!entry) {
        throw new Error("Expected a pending timer");
      }
      callbacks.delete(entry[0]);
      entry[1]();
    },
    pendingCount(): number {
      return callbacks.size;
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function browserSource(id: string): ClientSource {
  return { role: "browser", id, metadata: {} };
}

function windowLink(
  override: Partial<BrowserWindowLink> = {},
): BrowserWindowLink {
  const port = override.port ?? 48_735;
  return {
    url: override.url ?? `ws://127.0.0.1:${port}`,
    port,
    sessionId: override.sessionId ?? "session-10",
    bridgeInstanceId: override.bridgeInstanceId ?? INSTANCE_A,
    authToken: override.authToken ?? AUTH_TOKEN_A,
  };
}

function credentialsFor(link: BrowserWindowLink): BrowserCredentials {
  return {
    sessionId: link.sessionId,
    bridgeInstanceId: link.bridgeInstanceId,
    authToken: link.authToken,
  };
}

function windowIdFor(link: BrowserWindowLink): number {
  return link.port === 48_736 ? 20 : 10;
}

function selection(selector: string): InspectPayload {
  return {
    targets: [
      {
        role: "selected",
        depth: 0,
        subject: { selector, metadata: {} },
        facts: [],
        metadata: {},
      },
    ],
    context: { url: "http://localhost:3000", metadata: {} },
    metadata: {},
  };
}
