import { describe, expect, it } from "vitest";
import type { InspectPayload } from "../src/bridgeClient.js";
import {
  BackgroundInspectCoordinator,
} from "../src/backgroundInspectSession.js";
import {
  createBackgroundRouter,
  type BackgroundMessageSender,
  type BackgroundRuntimePort,
} from "../src/backgroundRouter.js";
import {
  createDevtoolsPanelPortName,
  INSPECT_CONTENT_LEASE_PORT_NAME,
} from "../src/inspectPortProtocol.js";
import type {
  PanelRegistration,
} from "../src/windowConnectionCoordinator.js";

const DEVTOOLS_URL = "moz-extension://browser2ide/dist/devtools.html";
const PANEL_URL = "moz-extension://browser2ide/dist/panel.html";

describe("BackgroundRouter", () => {
  it("accepts registration only from the exact injected DevTools URL", async () => {
    const harness = createHarness();
    const registration = registerMessage("channel-1", 17, "source-17");

    expect(await harness.router.routeMessage(registration, {})).toBeUndefined();
    expect(
      await harness.router.routeMessage(registration, {
        url: `${DEVTOOLS_URL}?panel=true`,
      }),
    ).toBeUndefined();
    expect(
      await harness.router.routeMessage(
        { ...registration, windowId: 999 },
        devtoolsSender(),
      ),
    ).toBeUndefined();
    expect(harness.getTabCalls).toEqual([]);

    expect(
      await harness.router.routeMessage(registration, devtoolsSender()),
    ).toEqual({ ok: true });
    expect(harness.getTabCalls).toEqual([17]);

    const absentUrlHarness = createHarness({ expectedDevtoolsUrl: undefined });
    expect(
      await absentUrlHarness.router.routeMessage(
        registration,
        devtoolsSender(),
      ),
    ).toBeUndefined();
    expect(absentUrlHarness.getTabCalls).toEqual([]);
  });

  it("derives the window, keeps exact re-registration idempotent, and posts state", async () => {
    const harness = createHarness();
    const registration = registerMessage("channel-1", 17, "source-17");

    await harness.router.routeMessage(registration, devtoolsSender());
    const port = harness.panelPort("channel-1");
    harness.router.connectPort(port);
    await harness.router.routeMessage(registration, devtoolsSender());

    expect(harness.coordinator.registrations).toHaveLength(1);
    expect(harness.coordinator.registrations[0]).toMatchObject({
      windowId: 10,
      tabId: 17,
      sourceId: "source-17",
    });
    expect(port.sent).toEqual([
      {
        type: "browser2ide.windowState",
        state: "notLinked",
      },
    ]);
  });

  it("coalesces concurrent exact re-announcements", async () => {
    const tabLookup = deferred<{ id: number; windowId: number }>();
    let getTabCalls = 0;
    const harness = createHarness({
      getTab: async () => {
        getTabCalls += 1;
        return tabLookup.promise;
      },
    });
    const registration = registerMessage("channel-1", 17, "source-17");

    const first = harness.router.routeMessage(registration, devtoolsSender());
    const second = harness.router.routeMessage(registration, devtoolsSender());
    expect(getTabCalls).toBe(1);
    tabLookup.resolve({ id: 17, windowId: 10 });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);
    harness.router.connectPort(harness.panelPort("channel-1"));
    expect(harness.coordinator.registrations).toHaveLength(1);
  });

  it("invalidates unresolved registrations across window removal", async () => {
    const tabLookup = deferred<{ id: number; windowId: number }>();
    const harness = createHarness({
      getTab: async () => tabLookup.promise,
    });
    const registration = harness.router.routeMessage(
      registerMessage("channel-1", 17, "source-17"),
      devtoolsSender(),
    );

    await harness.router.removeWindow(10);
    tabLookup.resolve({ id: 17, windowId: 10 });

    await expect(registration).resolves.toBeUndefined();
    harness.router.connectPort(harness.panelPort("channel-1"));
    expect(harness.coordinator.registrations).toEqual([]);
  });

  it("binds a valid panel port that arrives before registration", async () => {
    const harness = createHarness();
    const port = harness.panelPort("channel-1");

    harness.router.connectPort(port);
    expect(port.disconnected).toBe(false);
    expect(harness.coordinator.registrations).toEqual([]);

    await harness.router.routeMessage(
      registerMessage("channel-1", 17, "source-17"),
      devtoolsSender(),
    );

    expect(harness.coordinator.registrations).toHaveLength(1);
    expect(harness.coordinator.registrations[0]).toMatchObject({
      windowId: 10,
      tabId: 17,
      sourceId: "source-17",
    });
  });

  it("bounds pending ports and disconnects malformed, duplicate, and overflow ports", () => {
    const harness = createHarness({ maxPanelPorts: 2 });
    const malformed = harness.port("browser2ide.devtools.bad/channel");
    const wrongPage = harness.panelPort("wrong-page", {
      url: "moz-extension://browser2ide/dist/other.html?channel=wrong-page",
    });
    const first = harness.panelPort("first");
    const duplicate = harness.panelPort("first");
    const second = harness.panelPort("second");
    const overflow = harness.panelPort("third");

    harness.router.connectPort(malformed);
    harness.router.connectPort(wrongPage);
    harness.router.connectPort(first);
    harness.router.connectPort(duplicate);
    harness.router.connectPort(second);
    harness.router.connectPort(overflow);

    expect(malformed.disconnected).toBe(true);
    expect(wrongPage.disconnected).toBe(true);
    expect(first.disconnected).toBe(false);
    expect(duplicate.disconnected).toBe(true);
    expect(second.disconnected).toBe(false);
    expect(overflow.disconnected).toBe(true);
  });

  it("replaces only a stale inactive tab mapping and guards the resolution race", async () => {
    const tabLookup = deferred<{ id: number; windowId: number }>();
    let deferNew = false;
    const harness = createHarness({
      getTab: async (tabId) => {
        harness.getTabCalls.push(tabId);
        return deferNew
          ? tabLookup.promise
          : { id: tabId, windowId: 10 };
      },
    });
    await harness.router.routeMessage(
      registerMessage("old-channel", 17, "old-source"),
      devtoolsSender(),
    );

    deferNew = true;
    const replacing = harness.router.routeMessage(
      registerMessage("new-channel", 17, "new-source"),
      devtoolsSender(),
    );
    const oldPort = harness.panelPort("old-channel");
    harness.router.connectPort(oldPort);
    tabLookup.resolve({ id: 17, windowId: 10 });

    expect(await replacing).toBeUndefined();
    expect(harness.coordinator.registrations).toHaveLength(1);
    expect(harness.coordinator.registrations[0]?.sourceId).toBe("old-source");

    oldPort.disconnect();
    deferNew = false;
    expect(
      await harness.router.routeMessage(
        registerMessage("new-channel", 17, "new-source"),
        devtoolsSender(),
      ),
    ).toEqual({ ok: true });
    const newPort = harness.panelPort("new-channel");
    harness.router.connectPort(newPort);
    expect(harness.coordinator.registrations.at(-1)?.sourceId).toBe(
      "new-source",
    );

    const stalePort = harness.panelPort("old-channel");
    harness.router.connectPort(stalePort);
    expect(harness.coordinator.activeSources()).toEqual(["new-source"]);
  });

  it("rejects conflicting live channels and stale disconnects after recovery", async () => {
    const harness = createHarness();
    await harness.router.routeMessage(
      registerMessage("channel-1", 17, "source-17"),
      devtoolsSender(),
    );
    const first = harness.panelPort("channel-1");
    harness.router.connectPort(first);
    const delayedDisconnect = first.queueDisconnect();

    expect(
      await harness.router.routeMessage(
        registerMessage("channel-1", 18, "spoofed-source"),
        devtoolsSender(),
      ),
    ).toBeUndefined();
    expect(
      await harness.router.routeMessage(
        registerMessage("other-channel", 17, "other-source"),
        devtoolsSender(),
      ),
    ).toBeUndefined();

    first.disconnect();
    const recovered = harness.panelPort("channel-1");
    harness.router.connectPort(recovered);
    delayedDisconnect();

    expect(harness.coordinator.activeSources()).toEqual(["source-17"]);
    expect(harness.coordinator.registrations).toHaveLength(2);
    expect(harness.coordinator.disposeCalls).toBe(1);
  });

  it("publishes a validated payload only for the sender tab's active source", async () => {
    const harness = createHarness({
      tabs: new Map([
        [17, 10],
        [18, 20],
      ]),
    });
    await harness.registerAndConnect("channel-1", 17, "source-17");
    await harness.registerAndConnect("channel-2", 18, "source-18");
    const payloadWithDiagnostics = {
      ...inspectPayload(),
      inaccessibleStylesheets: [{ sourceUrl: "x", reason: "denied" }],
      panelTabId: 18,
    };

    expect(
      await harness.router.routeMessage(
        { type: "elementSelected", payload: payloadWithDiagnostics },
        contentSender(17, 10),
      ),
    ).toEqual({ ok: true });

    expect(harness.coordinator.published).toEqual([
      {
        windowId: 10,
        sourceId: "source-17",
        payload: inspectPayload(),
      },
    ]);
  });

  it("fails closed for invalid payloads, inactive tabs, and sender window mismatches", async () => {
    const harness = createHarness();
    await harness.registerAndConnect("channel-1", 17, "source-17");

    await harness.router.routeMessage(
      {
        type: "elementSelected",
        payload: { ...inspectPayload(), targets: [] },
      },
      contentSender(17, 10),
    );
    await harness.router.routeMessage(
      { type: "elementSelected", payload: inspectPayload() },
      contentSender(17, 999),
    );
    await harness.router.routeMessage(
      { type: "elementSelected", payload: inspectPayload() },
      contentSender(18, 10),
    );

    expect(harness.coordinator.published).toEqual([]);
  });

  it("keeps inspect commands and content leases bound to browser-derived tabs", async () => {
    const harness = createHarness();
    const panelPort = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );

    panelPort.emitMessage({
      type: "browser2ide.inspect.setEnabled",
      requestId: "spoof",
      tabId: 99,
      enabled: true,
    });
    panelPort.emitMessage({
      type: "browser2ide.inspect.setEnabled",
      requestId: "trusted",
      enabled: true,
    });
    await harness.inspectCoordinator.whenIdle(17);

    const crossTabLease = harness.port(INSPECT_CONTENT_LEASE_PORT_NAME, {
      tab: { id: 99, windowId: 10 },
    });
    harness.router.connectPort(crossTabLease);

    expect(harness.inspectCalls).toEqual([
      ["inject", { target: { tabId: 17 }, files: ["dist/contentScript.js"] }],
      ["tab", 17, { type: "enableInspectMode" }],
    ]);
    expect(crossTabLease.disconnected).toBe(true);
  });

  it("removes a browser window and tears down its registrations", async () => {
    const harness = createHarness();
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );

    await harness.router.removeWindow(10);

    expect(harness.coordinator.removedWindows).toEqual([10]);
    expect(harness.coordinator.disposeCalls).toBe(1);
    expect(port.disconnected).toBe(true);
    await harness.router.routeMessage(
      { type: "elementSelected", payload: inspectPayload() },
      contentSender(17, 10),
    );
    expect(harness.coordinator.published).toEqual([]);
  });

  it("disposes subscriptions, ports, inspect ownership, and panel registration once", async () => {
    const removedListeners: string[] = [];
    const harness = createHarness({
      subscriptions: {
        subscribeRuntimeMessages() {
          return () => removedListeners.push("message");
        },
        subscribeRuntimePorts() {
          return () => removedListeners.push("port");
        },
        subscribeWindowRemoved() {
          return () => removedListeners.push("window");
        },
      },
    });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    port.emitMessage({
      type: "browser2ide.inspect.setEnabled",
      requestId: "enable",
      enabled: true,
    });
    await harness.inspectCoordinator.whenIdle(17);

    harness.router.dispose();
    harness.router.dispose();
    await harness.inspectCoordinator.whenIdle(17);

    expect(removedListeners).toEqual(["message", "port", "window"]);
    expect(harness.coordinator.disposeCalls).toBe(1);
    expect(port.disconnected).toBe(true);
    expect(harness.inspectCalls.at(-1)).toEqual([
      "tab",
      17,
      { type: "disableInspectMode" },
    ]);
  });
});

interface HarnessOptions {
  readonly expectedDevtoolsUrl?: string;
  readonly maxPanelPorts?: number;
  readonly tabs?: ReadonlyMap<number, number>;
  readonly getTab?: (
    tabId: number,
  ) => Promise<{ id: number; windowId: number } | undefined>;
  readonly subscriptions?: {
    subscribeRuntimeMessages(
      listener: (
        message: unknown,
        sender: BackgroundMessageSender,
      ) => Promise<unknown>,
    ): () => void;
    subscribeRuntimePorts(
      listener: (port: BackgroundRuntimePort) => void,
    ): () => void;
    subscribeWindowRemoved(listener: (windowId: number) => void): () => void;
  };
}

function createHarness(options: HarnessOptions = {}) {
  const tabs = options.tabs ?? new Map([[17, 10]]);
  const getTabCalls: number[] = [];
  const inspectCalls: unknown[] = [];
  const coordinator = new FakeWindowCoordinator();
  const inspectCoordinator = new BackgroundInspectCoordinator({
    async executeScript(details) {
      inspectCalls.push(["inject", details]);
    },
    async sendTabMessage(tabId, message) {
      inspectCalls.push(["tab", tabId, message]);
    },
  });
  const harness = {
    coordinator,
    getTabCalls,
    inspectCalls,
    inspectCoordinator,
    router: undefined as unknown as ReturnType<typeof createBackgroundRouter>,
    port(
      name: string,
      sender: BackgroundMessageSender = {},
    ): FakePort {
      return new FakePort(name, sender);
    },
    panelPort(
      channel: string,
      sender: BackgroundMessageSender = panelSender(channel),
    ): FakePort {
      return new FakePort(createDevtoolsPanelPortName(channel), sender);
    },
    async registerAndConnect(
      channel: string,
      tabId: number,
      sourceId: string,
    ): Promise<FakePort> {
      await harness.router.routeMessage(
        registerMessage(channel, tabId, sourceId),
        devtoolsSender(),
      );
      const port = harness.panelPort(channel);
      harness.router.connectPort(port);
      return port;
    },
  };
  harness.router = createBackgroundRouter({
    expectedDevtoolsUrl: Object.hasOwn(options, "expectedDevtoolsUrl")
      ? options.expectedDevtoolsUrl
      : DEVTOOLS_URL,
    expectedPanelUrl: PANEL_URL,
    maxPanelPorts: options.maxPanelPorts,
    getTab:
      options.getTab ??
      (async (tabId) => {
        getTabCalls.push(tabId);
        const windowId = tabs.get(tabId);
        return windowId === undefined ? undefined : { id: tabId, windowId };
      }),
    coordinator,
    inspectCoordinator,
    subscriptions: options.subscriptions,
  });
  return harness;
}

class FakeWindowCoordinator {
  public readonly registrations: PanelRegistration[] = [];
  public readonly published: Array<{
    windowId: number;
    sourceId: string;
    payload: InspectPayload;
  }> = [];
  public readonly removedWindows: number[] = [];
  public disposeCalls = 0;
  private readonly active = new Set<PanelRegistration>();

  public registerPanel(registration: PanelRegistration): { dispose(): void } {
    this.registrations.push(registration);
    this.active.add(registration);
    registration.onStateChanged?.("notLinked");
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        this.disposeCalls += 1;
        this.active.delete(registration);
      },
    };
  }

  public publishInspect(
    windowId: number,
    sourceId: string,
    payload: InspectPayload,
  ): boolean {
    this.published.push({ windowId, sourceId, payload });
    return true;
  }

  public async removeWindow(windowId: number): Promise<void> {
    this.removedWindows.push(windowId);
  }

  public activeSources(): string[] {
    return [...this.active]
      .map((registration) => registration.sourceId)
      .sort();
  }
}

class FakePort implements BackgroundRuntimePort {
  public readonly sent: unknown[] = [];
  public disconnected = false;
  public readonly onMessage = new FakeEvent<(message: unknown) => void>();
  public readonly onDisconnect = new FakeEvent<() => void>();

  public constructor(
    public readonly name: string,
    public readonly sender: BackgroundMessageSender,
  ) {}

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

  public queueDisconnect(): () => void {
    const listeners = this.onDisconnect.snapshot();
    return () => {
      for (const listener of listeners) {
        listener();
      }
    };
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
    for (const listener of [...this.listeners]) {
      listener(...args);
    }
  }

  public snapshot(): T[] {
    return [...this.listeners];
  }
}

function registerMessage(channel: string, tabId: number, sourceId: string) {
  return {
    type: "browser2ide.registerDevtools",
    channel,
    tabId,
    sourceId,
  } as const;
}

function devtoolsSender(): BackgroundMessageSender {
  return { url: DEVTOOLS_URL };
}

function panelSender(channel: string): BackgroundMessageSender {
  return { url: `${PANEL_URL}?channel=${encodeURIComponent(channel)}` };
}

function contentSender(tabId: number, windowId: number): BackgroundMessageSender {
  return { tab: { id: tabId, windowId } };
}

function inspectPayload(): InspectPayload {
  return {
    targets: [
      {
        role: "selected",
        depth: 0,
        subject: { selector: ".card", metadata: {} },
        facts: [],
        metadata: {},
      },
    ],
    context: { url: "https://example.test/page", metadata: {} },
    metadata: {},
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
