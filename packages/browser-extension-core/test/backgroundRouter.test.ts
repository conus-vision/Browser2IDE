import { describe, expect, it } from "vitest";
import {
  BrowserProtocolError,
  type InspectPayload,
} from "../src/bridgeClient.js";
import {
  BackgroundInspectCoordinator,
} from "../src/backgroundInspectSession.js";
import {
  createBackgroundRouter,
  type BackgroundMessageSender,
  type BackgroundRouterSubscriptions,
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

  it("allows an unresolved registration in another window to complete", async () => {
    const tabLookup = deferred<{ id: number; windowId: number }>();
    const harness = createHarness({
      getTab: async (tabId) =>
        tabId === 18 ? tabLookup.promise : { id: tabId, windowId: 10 },
    });
    const windowAPort = await harness.registerAndConnect(
      "channel-a",
      17,
      "source-a",
    );
    const registration = harness.router.routeMessage(
      registerMessage("channel-b", 18, "source-b"),
      devtoolsSender(),
    );

    await harness.router.removeWindow(10);
    tabLookup.resolve({ id: 18, windowId: 20 });

    await expect(registration).resolves.toEqual({ ok: true });
    const windowBPort = harness.panelPort("channel-b");
    harness.router.connectPort(windowBPort);
    expect(windowAPort.disconnected).toBe(true);
    expect(windowBPort.disconnected).toBe(false);
    expect(harness.coordinator.activeSources()).toEqual(["source-b"]);
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

  it.each(["before", "after"] as const)(
    "atomically supersedes a live same-tab channel when the new port arrives %s the announcement",
    async (portOrder) => {
      const harness = createHarness();
      const oldPort = await harness.registerAndConnect(
        "old-channel",
        17,
        "old-source",
      );
      const delayedOldDisconnect = oldPort.queueDisconnect();
      const newPort = harness.panelPort("new-channel");
      if (portOrder === "before") {
        harness.router.connectPort(newPort);
      }

      const result = await harness.router.routeMessage(
        registerMessage("new-channel", 17, "new-source"),
        devtoolsSender(),
      );
      if (portOrder === "after") {
        harness.router.connectPort(newPort);
      }

      expect(result).toEqual({ ok: true });
      expect(oldPort.disconnected).toBe(true);
      expect(newPort.disconnected).toBe(false);
      expect(harness.coordinator.activeSources()).toEqual(["new-source"]);
      expect(harness.coordinator.registrations).toHaveLength(2);
      expect(harness.coordinator.disposeCalls).toBe(1);

      delayedOldDisconnect();

      expect(newPort.disconnected).toBe(false);
      expect(harness.coordinator.activeSources()).toEqual(["new-source"]);
      expect(harness.coordinator.disposeCalls).toBe(1);
    },
  );

  it("does not let an older re-announcement reclaim a superseded tab", async () => {
    const staleLookup = deferred<{ id: number; windowId: number }>();
    let deferNextLookup = false;
    const harness = createHarness({
      getTab: async (tabId) => {
        if (deferNextLookup) {
          deferNextLookup = false;
          return staleLookup.promise;
        }
        return { id: tabId, windowId: 10 };
      },
    });
    await harness.registerAndConnect("old-channel", 17, "old-source");
    deferNextLookup = true;
    const staleAnnouncement = harness.router.routeMessage(
      registerMessage("old-channel", 17, "old-source"),
      devtoolsSender(),
    );
    const newPort = harness.panelPort("new-channel");
    harness.router.connectPort(newPort);

    await expect(
      harness.router.routeMessage(
        registerMessage("new-channel", 17, "new-source"),
        devtoolsSender(),
      ),
    ).resolves.toEqual({ ok: true });
    staleLookup.resolve({ id: 17, windowId: 10 });

    await expect(staleAnnouncement).resolves.toBeUndefined();
    expect(newPort.disconnected).toBe(false);
    expect(harness.coordinator.activeSources()).toEqual(["new-source"]);
    expect(harness.coordinator.disposeCalls).toBe(1);
  });

  it("does not roll a moved tab back when lookups resolve 10, 20, then 10", async () => {
    const staleLookup = deferred<{ id: number; windowId: number }>();
    let lookup = 0;
    const harness = createHarness({
      getTab: async (tabId) => {
        lookup += 1;
        if (lookup === 1) {
          return { id: tabId, windowId: 10 };
        }
        if (lookup === 2) {
          return staleLookup.promise;
        }
        return { id: tabId, windowId: 20 };
      },
    });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );

    const staleAnnouncement = harness.router.routeMessage(
      registerMessage("channel-1", 17, "source-17"),
      devtoolsSender(),
    );
    await expect(
      harness.router.routeMessage(
        { type: "elementSelected", payload: inspectPayload() },
        contentSender(17, 20),
      ),
    ).resolves.toEqual({ ok: true });
    expect(harness.coordinator.registrations.at(-1)).toMatchObject({
      windowId: 20,
      tabId: 17,
      sourceId: "source-17",
    });

    staleLookup.resolve({ id: 17, windowId: 10 });
    await expect(staleAnnouncement).resolves.toEqual({ ok: true });

    expect(harness.coordinator.registrations.at(-1)).toMatchObject({
      windowId: 20,
      tabId: 17,
      sourceId: "source-17",
    });
    expect(harness.coordinator.activeSources()).toEqual(["source-17"]);
    expect(port.disconnected).toBe(false);
  });

  it("refreshes a recovered panel through its pending registration before activation", async () => {
    const movedLookup = deferred<{ id: number; windowId: number }>();
    let lookup = 0;
    const harness = createHarness({
      getTab: async (tabId) => {
        lookup += 1;
        return lookup === 1
          ? { id: tabId, windowId: 10 }
          : movedLookup.promise;
      },
    });
    const oldPort = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    const oldRegistration = harness.coordinator.registrations[0];
    const registration = harness.router.routeMessage(
      registerMessage("channel-1", 17, "source-17"),
      devtoolsSender(),
    );
    await flushMicrotasks();

    oldPort.disconnect();
    const recoveredPort = harness.panelPort("channel-1");
    harness.router.connectPort(recoveredPort);

    expect(harness.coordinator.registrations.map(({ windowId }) => windowId))
      .toEqual([10]);
    expect(harness.coordinator.activeSources()).toEqual([]);
    expect(recoveredPort.sent).toEqual([]);

    movedLookup.resolve({ id: 17, windowId: 20 });
    await expect(registration).resolves.toEqual({ ok: true });

    expect(harness.coordinator.registrations.map(({ windowId }) => windowId))
      .toEqual([10, 20]);
    expect(harness.coordinator.activeSources()).toEqual(["source-17"]);
    expect(recoveredPort.sent).toEqual([
      {
        type: "browser2ide.windowState",
        state: "notLinked",
      },
    ]);

    oldRegistration?.onStateChanged?.("linked");
    expect(recoveredPort.sent).toHaveLength(1);
  });

  it("uses attach as the authority when initial registration lookup returns stale A", async () => {
    const staleLookup = deferred<{ id: number; windowId: number }>();
    const events = createRouterSubscriptionHarness();
    const harness = createHarness({
      subscriptions: events.subscriptions,
      getTab: async () => staleLookup.promise,
    });
    const port = harness.panelPort("channel-1");
    harness.router.connectPort(port);
    const registration = harness.router.routeMessage(
      registerMessage("channel-1", 17, "source-17"),
      devtoolsSender(),
    );
    await flushMicrotasks();

    events.detach(17, 10);
    events.attach(17, 20);
    staleLookup.resolve({ id: 17, windowId: 10 });

    await expect(registration).resolves.toEqual({ ok: true });
    expect(harness.coordinator.registrations.map(({ windowId }) => windowId))
      .toEqual([20]);
    expect(harness.coordinator.activeSources()).toEqual(["source-17"]);
    expect(port.disconnected).toBe(false);
  });

  it("rejects conflicting channel tuples and cross-tab source hijacks", async () => {
    const harness = createHarness({
      tabs: new Map([
        [17, 10],
        [18, 20],
      ]),
    });
    await harness.router.routeMessage(
      registerMessage("channel-1", 17, "source-17"),
      devtoolsSender(),
    );
    const first = harness.panelPort("channel-1");
    harness.router.connectPort(first);
    const delayedDisconnect = first.queueDisconnect();
    await harness.registerAndConnect("channel-2", 18, "source-18");

    expect(
      await harness.router.routeMessage(
        registerMessage("channel-1", 18, "spoofed-source"),
        devtoolsSender(),
      ),
    ).toBeUndefined();
    expect(
      await harness.router.routeMessage(
        registerMessage("hijack-channel", 17, "source-18"),
        devtoolsSender(),
      ),
    ).toBeUndefined();
    expect(harness.coordinator.activeSources()).toEqual([
      "source-17",
      "source-18",
    ]);

    first.disconnect();
    const recovered = harness.panelPort("channel-1");
    harness.router.connectPort(recovered);
    delayedDisconnect();

    expect(harness.coordinator.activeSources()).toEqual([
      "source-17",
      "source-18",
    ]);
    expect(harness.coordinator.registrations).toHaveLength(3);
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

  it("allows an in-flight selection in another window to publish", async () => {
    const tabLookup = deferred<{ id: number; windowId: number }>();
    let deferWindowB = false;
    const harness = createHarness({
      getTab: async (tabId) => {
        if (deferWindowB && tabId === 18) {
          return tabLookup.promise;
        }
        return { id: tabId, windowId: tabId === 17 ? 10 : 20 };
      },
    });
    await harness.registerAndConnect("channel-a", 17, "source-a");
    await harness.registerAndConnect("channel-b", 18, "source-b");
    deferWindowB = true;

    const publishing = harness.router.routeMessage(
      { type: "elementSelected", payload: inspectPayload() },
      contentSender(18, 20),
    );
    await harness.router.removeWindow(10);
    tabLookup.resolve({ id: 18, windowId: 20 });

    await expect(publishing).resolves.toEqual({ ok: true });
    expect(harness.coordinator.published).toEqual([
      {
        windowId: 20,
        sourceId: "source-b",
        payload: inspectPayload(),
      },
    ]);
    expect(harness.coordinator.activeSources()).toEqual(["source-b"]);
  });

  it("does not publish an in-flight selection from a removed window", async () => {
    const tabLookup = deferred<{ id: number; windowId: number }>();
    let deferSelection = false;
    const harness = createHarness({
      getTab: async (tabId) =>
        deferSelection ? tabLookup.promise : { id: tabId, windowId: 10 },
    });
    await harness.registerAndConnect("channel-a", 17, "source-a");
    deferSelection = true;

    const publishing = harness.router.routeMessage(
      { type: "elementSelected", payload: inspectPayload() },
      contentSender(17, 10),
    );
    await harness.router.removeWindow(10);
    tabLookup.resolve({ id: 17, windowId: 10 });

    await expect(publishing).resolves.toBeUndefined();
    expect(harness.coordinator.published).toEqual([]);
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
    await flushMicrotasks();
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

  it("links and unlinks only the window derived from the trusted panel binding", async () => {
    const harness = createHarness();
    await harness.registerAndConnect("channel-1", 17, "source-17");

    await expect(
      harness.router.routeMessage(
        {
          type: "browser2ide.linkWindow",
          channel: "channel-1",
          code: "4873507",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      harness.router.routeMessage(
        {
          type: "browser2ide.unlinkWindow",
          channel: "channel-1",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: true });

    expect(harness.coordinator.links).toEqual([
      {
        windowId: 10,
        code: "4873507",
        source: {
          role: "browser",
          id: "source-17",
          metadata: {},
        },
      },
    ]);
    expect(harness.coordinator.unlinks).toEqual([10]);
  });

  it("migrates a moved tab before Link, Unlink, and Inspect", async () => {
    const tabs = new Map([[17, 10]]);
    const harness = createHarness({ tabs });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );

    tabs.set(17, 20);
    await expect(
      harness.router.routeMessage(
        {
          type: "browser2ide.linkWindow",
          channel: "channel-1",
          code: "4873507",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: true });

    tabs.set(17, 30);
    await expect(
      harness.router.routeMessage(
        {
          type: "browser2ide.unlinkWindow",
          channel: "channel-1",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: true });
    port.emitMessage({
      type: "browser2ide.inspect.setEnabled",
      requestId: "moved-enable",
      enabled: true,
    });
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);

    expect(harness.coordinator.links.map(({ windowId }) => windowId)).toEqual([20]);
    expect(harness.coordinator.unlinks).toEqual([30]);
    expect(harness.coordinator.registrations.at(-1)).toMatchObject({
      windowId: 30,
      tabId: 17,
      sourceId: "source-17",
    });
    expect(harness.coordinator.activeSources()).toEqual(["source-17"]);
    expect(harness.inspectCalls).toEqual([
      ["inject", { target: { tabId: 17 }, files: ["dist/contentScript.js"] }],
      ["tab", 17, { type: "enableInspectMode" }],
    ]);
    expect(harness.getTabCalls).toEqual([17, 17, 17, 17, 17, 17, 17]);
  });

  it("invalidates a closed tab before window commands or Inspect", async () => {
    const tabs = new Map([[17, 10]]);
    const harness = createHarness({ tabs });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    tabs.delete(17);

    port.emitMessage({
      type: "browser2ide.inspect.setEnabled",
      requestId: "closed-enable",
      enabled: true,
    });
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);
    await expect(
      harness.router.routeMessage(
        {
          type: "browser2ide.unlinkWindow",
          channel: "channel-1",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: false, error: "stalePanel" });

    expect(harness.inspectCalls).toEqual([]);
    expect(harness.coordinator.unlinks).toEqual([]);
    expect(harness.coordinator.activeSources()).toEqual([]);
    expect(port.sent).toContainEqual({
      type: "browser2ide.inspect.result",
      requestId: "closed-enable",
      ok: false,
      error: "stalePanel",
    });
  });

  it("does not dispatch a command after its tab lookup loses the panel", async () => {
    const movedTab = deferred<{ id: number; windowId: number }>();
    let lookupCount = 0;
    const harness = createHarness({
      getTab: async (tabId) => {
        lookupCount += 1;
        return lookupCount === 1
          ? { id: tabId, windowId: 10 }
          : movedTab.promise;
      },
    });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );

    const command = harness.router.routeMessage(
      {
        type: "browser2ide.linkWindow",
        channel: "channel-1",
        code: "4873507",
      },
      panelSender("channel-1"),
    );
    await Promise.resolve();
    port.disconnect();
    movedTab.resolve({ id: 17, windowId: 20 });

    await expect(command).resolves.toEqual({ ok: false, error: "stalePanel" });
    expect(harness.coordinator.links).toEqual([]);
  });

  it("rejects spoofed panel URLs, channels, IDs, and extra command keys", async () => {
    const harness = createHarness();
    await harness.registerAndConnect("channel-1", 17, "source-17");
    const link = {
      type: "browser2ide.linkWindow",
      channel: "channel-1",
      code: "4873507",
    } as const;

    expect(
      await harness.router.routeMessage(link, {
        url: `${PANEL_URL}?channel=channel-1#spoof`,
      }),
    ).toBeUndefined();
    expect(
      await harness.router.routeMessage(
        { ...link, channel: "channel-2" },
        panelSender("channel-2"),
      ),
    ).toBeUndefined();
    expect(
      await harness.router.routeMessage(
        { ...link, windowId: 99 },
        panelSender("channel-1"),
      ),
    ).toBeUndefined();
    expect(
      await harness.router.routeMessage(
        {
          type: "browser2ide.unlinkWindow",
          channel: "channel-1",
          tabId: 99,
        },
        panelSender("channel-1"),
      ),
    ).toBeUndefined();
    expect(harness.coordinator.links).toEqual([]);
    expect(harness.coordinator.unlinks).toEqual([]);
  });

  it("returns sanitized failures for invalid codes and stale panel bindings", async () => {
    const harness = createHarness();
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );

    await expect(
      harness.router.routeMessage(
        {
          type: "browser2ide.linkWindow",
          channel: "channel-1",
          code: "0999907",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: false, error: "invalidCode" });

    port.disconnect();
    await expect(
      harness.router.routeMessage(
        {
          type: "browser2ide.unlinkWindow",
          channel: "channel-1",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: false, error: "stalePanel" });
    expect(harness.coordinator.links).toEqual([]);
    expect(harness.coordinator.unlinks).toEqual([]);
  });

  it("rejects malformed or oversized link codes before coordinator dispatch", async () => {
    const harness = createHarness();
    await harness.registerAndConnect("channel-1", 17, "source-17");

    for (const code of ["48735 07", "48735070", "48735x7", ""] as const) {
      expect(
        await harness.router.routeMessage(
          {
            type: "browser2ide.linkWindow",
            channel: "channel-1",
            code,
          },
          panelSender("channel-1"),
        ),
      ).toBeUndefined();
    }
    expect(harness.coordinator.links).toEqual([]);
  });

  it("allows only one reentrant command per active panel channel", async () => {
    const linkResult = deferred<void>();
    const harness = createHarness({
      linkWindow: async () => linkResult.promise,
    });
    await harness.registerAndConnect("channel-1", 17, "source-17");
    const message = {
      type: "browser2ide.linkWindow",
      channel: "channel-1",
      code: "4873507",
    } as const;

    const first = harness.router.routeMessage(
      message,
      panelSender("channel-1"),
    );
    await Promise.resolve();
    await expect(
      harness.router.routeMessage(message, panelSender("channel-1")),
    ).resolves.toEqual({ ok: false, error: "busy" });
    linkResult.resolve();
    await expect(first).resolves.toEqual({ ok: true });

    expect(harness.coordinator.links).toHaveLength(1);
  });

  it("maps coordinator rate limits and errors without exposing their messages", async () => {
    const rateLimited = createHarness({
      linkWindow: async () => {
        throw new BrowserProtocolError(
          "link.rateLimited",
          "secret server detail",
        );
      },
    });
    await rateLimited.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    await expect(
      rateLimited.router.routeMessage(
        {
          type: "browser2ide.linkWindow",
          channel: "channel-1",
          code: "4873507",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: false, error: "rateLimited" });
    expect(rateLimited.reportedErrors).toEqual([]);

    const failed = createHarness({
      unlinkWindow: async () => {
        throw new Error("secret storage detail");
      },
    });
    await failed.registerAndConnect("channel-1", 17, "source-17");
    await expect(
      failed.router.routeMessage(
        {
          type: "browser2ide.unlinkWindow",
          channel: "channel-1",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: false, error: "error" });
    expect(failed.reportedErrors).toHaveLength(1);
    expect(failed.reportedErrors[0]).toBeInstanceOf(Error);
    expect((failed.reportedErrors[0] as Error).message).toBe(
      "Browser2IDE panel command failed",
    );
    expect((failed.reportedErrors[0] as Error).message).not.toContain(
      "secret storage detail",
    );
  });

  it("does not report success after an async command loses its panel binding", async () => {
    const linkResult = deferred<void>();
    const harness = createHarness({
      linkWindow: async () => linkResult.promise,
    });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    const result = harness.router.routeMessage(
      {
        type: "browser2ide.linkWindow",
        channel: "channel-1",
        code: "4873507",
      },
      panelSender("channel-1"),
    );
    await flushMicrotasks();

    port.disconnect();
    linkResult.resolve();

    await expect(result).resolves.toEqual({ ok: false, error: "stalePanel" });
  });

  it("does not report an async command error to a stale panel binding", async () => {
    const linkResult = deferred<void>();
    const harness = createHarness({
      linkWindow: async () => linkResult.promise,
    });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    const result = harness.router.routeMessage(
      {
        type: "browser2ide.linkWindow",
        channel: "channel-1",
        code: "4873507",
      },
      panelSender("channel-1"),
    );
    await flushMicrotasks();

    port.disconnect();
    linkResult.reject(new Error("secret stale failure"));

    await expect(result).resolves.toEqual({ ok: false, error: "stalePanel" });
  });

  it.each(["link", "unlink"] as const)(
    "cancels an in-flight %s from window A when the tab migrates to B",
    async (kind) => {
      const tabs = new Map([[17, 10]]);
      const operation = deferred<void>();
      const signals: AbortSignal[] = [];
      const behavior = async (signal: AbortSignal | undefined): Promise<void> => {
        if (signal) {
          signals.push(signal);
        }
        await operation.promise;
      };
      const harness = createHarness({
        tabs,
        linkWindow: async (_windowId, _code, _source, signal) =>
          behavior(signal),
        unlinkWindow: async (_windowId, signal) => behavior(signal),
      });
      const port = await harness.registerAndConnect(
        "channel-1",
        17,
        "source-17",
      );
      const staleRegistration = harness.coordinator.registrations.at(-1);
      const command = harness.router.routeMessage(
        kind === "link"
          ? {
              type: "browser2ide.linkWindow",
              channel: "channel-1",
              code: "4873507",
            }
          : {
              type: "browser2ide.unlinkWindow",
              channel: "channel-1",
            },
        panelSender("channel-1"),
      );
      await flushMicrotasks();

      tabs.set(17, 20);
      await expect(
        harness.router.routeMessage(
          { type: "elementSelected", payload: inspectPayload() },
          contentSender(17, 20),
        ),
      ).resolves.toEqual({ ok: true });

      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
      operation.resolve();
      await expect(command).resolves.toEqual({
        ok: false,
        error: "stalePanel",
      });

      const messagesBeforeStaleState = port.sent.length;
      staleRegistration?.onStateChanged?.("linked");
      expect(port.sent).toHaveLength(messagesBeforeStaleState);
      expect(harness.coordinator.registrations.at(-1)).toMatchObject({
        windowId: 20,
        tabId: 17,
        sourceId: "source-17",
      });
      expect(harness.coordinator.activeSources()).toEqual(["source-17"]);
    },
  );

  it.each(["link", "unlink"] as const)(
    "suspends an in-flight %s on detach and reactivates it only after attach",
    async (kind) => {
      const tabs = new Map([[17, 10]]);
      const events = createRouterSubscriptionHarness();
      const operation = deferred<void>();
      const signals: AbortSignal[] = [];
      const behavior = async (signal: AbortSignal | undefined): Promise<void> => {
        if (signal) {
          signals.push(signal);
        }
        await operation.promise;
      };
      const harness = createHarness({
        tabs,
        subscriptions: events.subscriptions,
        linkWindow: async (_windowId, _code, _source, signal) =>
          behavior(signal),
        unlinkWindow: async (_windowId, signal) => behavior(signal),
      });
      const port = await harness.registerAndConnect(
        "channel-1",
        17,
        "source-17",
      );
      const staleRegistration = harness.coordinator.registrations.at(-1);
      const command = harness.router.routeMessage(
        kind === "link"
          ? {
              type: "browser2ide.linkWindow",
              channel: "channel-1",
              code: "4873507",
            }
          : {
              type: "browser2ide.unlinkWindow",
              channel: "channel-1",
            },
        panelSender("channel-1"),
      );
      await flushMicrotasks();

      events.detach(17, 10);

      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
      expect(harness.coordinator.activeSources()).toEqual([]);

      tabs.set(17, 20);
      events.attach(17, 20);
      expect(harness.coordinator.registrations.at(-1)).toMatchObject({
        windowId: 20,
        tabId: 17,
        sourceId: "source-17",
      });
      expect(harness.coordinator.activeSources()).toEqual(["source-17"]);

      operation.resolve();
      await expect(command).resolves.toEqual({
        ok: false,
        error: "stalePanel",
      });

      const messagesBeforeStaleState = port.sent.length;
      staleRegistration?.onStateChanged?.("linked");
      expect(port.sent).toHaveLength(messagesBeforeStaleState);
    },
  );

  it.each(["link", "unlink"] as const)(
    "does not acknowledge a quiet A-to-B move after deferred %s",
    async (kind) => {
      const tabs = new Map([[17, 10]]);
      const operation = deferred<void>();
      let signal: AbortSignal | undefined;
      const behavior = async (currentSignal: AbortSignal | undefined) => {
        signal = currentSignal;
        await operation.promise;
      };
      const harness = createHarness({
        tabs,
        linkWindow: async (_windowId, _code, _source, currentSignal) =>
          behavior(currentSignal),
        unlinkWindow: async (_windowId, currentSignal) =>
          behavior(currentSignal),
      });
      const port = await harness.registerAndConnect(
        "channel-1",
        17,
        "source-17",
      );
      const staleRegistration = harness.coordinator.registrations.at(-1);
      const command = harness.router.routeMessage(
        kind === "link"
          ? {
              type: "browser2ide.linkWindow",
              channel: "channel-1",
              code: "4873507",
            }
          : {
              type: "browser2ide.unlinkWindow",
              channel: "channel-1",
            },
        panelSender("channel-1"),
      );
      await flushMicrotasks();

      tabs.set(17, 20);
      operation.resolve();

      await expect(command).resolves.toEqual({
        ok: false,
        error: "stalePanel",
      });
      expect(signal?.aborted).toBe(true);
      expect(harness.coordinator.registrations.at(-1)).toMatchObject({
        windowId: 20,
        tabId: 17,
        sourceId: "source-17",
      });
      expect(harness.coordinator.activeSources()).toEqual(["source-17"]);

      const messagesBeforeStaleState = port.sent.length;
      staleRegistration?.onStateChanged?.("linked");
      expect(port.sent).toHaveLength(messagesBeforeStaleState);
    },
  );

  it("invalidates a quietly closed tab after a deferred command", async () => {
    const tabs = new Map([[17, 10]]);
    const operation = deferred<void>();
    let signal: AbortSignal | undefined;
    const harness = createHarness({
      tabs,
      unlinkWindow: async (_windowId, currentSignal) => {
        signal = currentSignal;
        await operation.promise;
      },
    });
    await harness.registerAndConnect("channel-1", 17, "source-17");
    const command = harness.router.routeMessage(
      {
        type: "browser2ide.unlinkWindow",
        channel: "channel-1",
      },
      panelSender("channel-1"),
    );
    await flushMicrotasks();

    tabs.delete(17);
    operation.resolve();

    await expect(command).resolves.toEqual({
      ok: false,
      error: "stalePanel",
    });
    expect(signal?.aborted).toBe(true);
    expect(harness.coordinator.activeSources()).toEqual([]);
  });

  it("cancels an in-flight window command when its tab closes", async () => {
    const tabs = new Map([[17, 10]]);
    const operation = deferred<void>();
    let signal: AbortSignal | undefined;
    const harness = createHarness({
      tabs,
      linkWindow: async (_windowId, _code, _source, currentSignal) => {
        signal = currentSignal;
        await operation.promise;
      },
    });
    await harness.registerAndConnect("channel-1", 17, "source-17");
    const command = harness.router.routeMessage(
      {
        type: "browser2ide.linkWindow",
        channel: "channel-1",
        code: "4873507",
      },
      panelSender("channel-1"),
    );
    await flushMicrotasks();

    tabs.delete(17);
    await expect(
      harness.router.routeMessage(
        { type: "elementSelected", payload: inspectPayload() },
        contentSender(17, 10),
      ),
    ).resolves.toBeUndefined();

    expect(signal?.aborted).toBe(true);
    operation.resolve();
    await expect(command).resolves.toEqual({
      ok: false,
      error: "stalePanel",
    });
    expect(harness.coordinator.activeSources()).toEqual([]);
  });

  it("settles pending Inspect as stale when its tab migrates to another window", async () => {
    const tabs = new Map([[17, 10]]);
    const enable = deferred<void>();
    const harness = createHarness({
      tabs,
      sendTabMessage: async (_tabId, message) => {
        if (isRecord(message) && message.type === "enableInspectMode") {
          await enable.promise;
        }
      },
    });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    port.emitMessage({
      type: "browser2ide.inspect.setEnabled",
      requestId: "pending-enable",
      enabled: true,
    });
    await flushMicrotasks();

    tabs.set(17, 20);
    await expect(
      harness.router.routeMessage(
        { type: "elementSelected", payload: inspectPayload() },
        contentSender(17, 20),
      ),
    ).resolves.toEqual({ ok: true });

    expect(port.sent).toContainEqual({
      type: "browser2ide.inspect.result",
      requestId: "pending-enable",
      ok: false,
      error: "stalePanel",
    });
    expect(port.sent).not.toContainEqual({
      type: "browser2ide.inspect.result",
      requestId: "pending-enable",
      ok: true,
    });

    enable.resolve();
    await harness.inspectCoordinator.whenIdle(17);
    await flushMicrotasks();

    expect(port.sent).not.toContainEqual({
      type: "browser2ide.inspect.result",
      requestId: "pending-enable",
      ok: true,
    });
    expect(harness.inspectCalls.at(-1)).toEqual([
      "tab",
      17,
      { type: "disableInspectMode" },
    ]);
    expect(harness.coordinator.registrations.at(-1)).toMatchObject({
      windowId: 20,
      tabId: 17,
      sourceId: "source-17",
    });
  });

  it("settles pending Inspect on detach and reactivates only after attach", async () => {
    const tabs = new Map([[17, 10]]);
    const events = createRouterSubscriptionHarness();
    const enable = deferred<void>();
    const harness = createHarness({
      tabs,
      subscriptions: events.subscriptions,
      sendTabMessage: async (_tabId, message) => {
        if (isRecord(message) && message.type === "enableInspectMode") {
          await enable.promise;
        }
      },
    });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    port.emitMessage({
      type: "browser2ide.inspect.setEnabled",
      requestId: "detached-enable",
      enabled: true,
    });
    await flushMicrotasks();

    events.detach(17, 10);

    expect(harness.coordinator.activeSources()).toEqual([]);
    expect(inspectResults(port)).toEqual([
      {
        type: "browser2ide.inspect.result",
        requestId: "detached-enable",
        ok: false,
        error: "stalePanel",
      },
    ]);

    tabs.set(17, 20);
    events.attach(17, 20);
    expect(harness.coordinator.registrations.at(-1)).toMatchObject({
      windowId: 20,
      tabId: 17,
      sourceId: "source-17",
    });

    enable.resolve();
    await harness.inspectCoordinator.whenIdle(17);
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);

    expect(inspectResults(port)).toHaveLength(1);
    expect(harness.inspectCalls.at(-1)).toEqual([
      "tab",
      17,
      { type: "disableInspectMode" },
    ]);
  });

  it.each(["executeScript", "sendTabMessage"] as const)(
    "does not acknowledge a quiet A-to-B move during deferred Inspect %s",
    async (stage) => {
      const tabs = new Map([[17, 10]]);
      const enable = deferred<void>();
      const harness = createHarness({
        tabs,
        executeScript: async () => {
          if (stage === "executeScript") {
            await enable.promise;
          }
        },
        sendTabMessage: async (_tabId, message) => {
          if (
            stage === "sendTabMessage" &&
            isRecord(message) &&
            message.type === "enableInspectMode"
          ) {
            await enable.promise;
          }
        },
      });
      const port = await harness.registerAndConnect(
        "channel-1",
        17,
        "source-17",
      );
      port.emitMessage({
        type: "browser2ide.inspect.setEnabled",
        requestId: `quiet-${stage}`,
        enabled: true,
      });
      await flushMicrotasks();

      tabs.set(17, 20);
      enable.resolve();
      await harness.inspectCoordinator.whenIdle(17);
      await flushMicrotasks();
      await harness.inspectCoordinator.whenIdle(17);

      expect(inspectResults(port)).toEqual([
        {
          type: "browser2ide.inspect.result",
          requestId: `quiet-${stage}`,
          ok: false,
          error: "stalePanel",
        },
      ]);
      expect(harness.inspectCalls.at(-1)).toEqual([
        "tab",
        17,
        { type: "disableInspectMode" },
      ]);
      expect(harness.coordinator.registrations.at(-1)).toMatchObject({
        windowId: 20,
        tabId: 17,
        sourceId: "source-17",
      });
      expect(harness.coordinator.activeSources()).toEqual(["source-17"]);
    },
  );

  it("does not acknowledge a quiet move during deferred Inspect disable", async () => {
    const tabs = new Map([[17, 10]]);
    const disable = deferred<void>();
    const harness = createHarness({
      tabs,
      sendTabMessage: async (_tabId, message) => {
        if (isRecord(message) && message.type === "disableInspectMode") {
          await disable.promise;
        }
      },
    });
    const port = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    port.emitMessage({
      type: "browser2ide.inspect.setEnabled",
      requestId: "enable-before-disable",
      enabled: true,
    });
    await harness.inspectCoordinator.whenIdle(17);
    await flushMicrotasks();

    port.emitMessage({
      type: "browser2ide.inspect.setEnabled",
      requestId: "quiet-disable",
      enabled: false,
    });
    await flushMicrotasks();
    tabs.set(17, 20);
    disable.resolve();
    await harness.inspectCoordinator.whenIdle(17);
    await flushMicrotasks();

    expect(inspectResults(port)).toEqual([
      {
        type: "browser2ide.inspect.result",
        requestId: "enable-before-disable",
        ok: true,
      },
      {
        type: "browser2ide.inspect.result",
        requestId: "quiet-disable",
        ok: false,
        error: "stalePanel",
      },
    ]);
    expect(harness.coordinator.registrations.at(-1)).toMatchObject({
      windowId: 20,
      tabId: 17,
      sourceId: "source-17",
    });
  });

  it("does not let a stale command block a recovered port on the same channel", async () => {
    const linkResult = deferred<void>();
    const harness = createHarness({
      linkWindow: async () => linkResult.promise,
    });
    const firstPort = await harness.registerAndConnect(
      "channel-1",
      17,
      "source-17",
    );
    const staleLink = harness.router.routeMessage(
      {
        type: "browser2ide.linkWindow",
        channel: "channel-1",
        code: "4873507",
      },
      panelSender("channel-1"),
    );
    await flushMicrotasks();
    firstPort.disconnect();

    const recoveredPort = harness.panelPort("channel-1");
    harness.router.connectPort(recoveredPort);
    await expect(
      harness.router.routeMessage(
        {
          type: "browser2ide.unlinkWindow",
          channel: "channel-1",
        },
        panelSender("channel-1"),
      ),
    ).resolves.toEqual({ ok: true });

    linkResult.resolve();
    await expect(staleLink).resolves.toEqual({
      ok: false,
      error: "stalePanel",
    });
    expect(harness.coordinator.unlinks).toEqual([10]);
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
        subscribeTabDetached() {
          return () => removedListeners.push("detached");
        },
        subscribeTabAttached() {
          return () => removedListeners.push("attached");
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
    await flushMicrotasks();
    await harness.inspectCoordinator.whenIdle(17);

    harness.router.dispose();
    harness.router.dispose();
    await harness.inspectCoordinator.whenIdle(17);

    expect(removedListeners).toEqual([
      "message",
      "port",
      "window",
      "detached",
      "attached",
    ]);
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
  readonly subscriptions?: BackgroundRouterSubscriptions;
  readonly executeScript?: (details: {
    target: { tabId: number };
    files: string[];
  }) => Promise<unknown>;
  readonly sendTabMessage?: (
    tabId: number,
    message: unknown,
  ) => Promise<unknown>;
  readonly linkWindow?: (
    windowId: number,
    code: string,
    source: unknown,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly unlinkWindow?: (
    windowId: number,
    signal?: AbortSignal,
  ) => Promise<void>;
}

function createHarness(options: HarnessOptions = {}) {
  const tabs = options.tabs ?? new Map([[17, 10]]);
  const getTabCalls: number[] = [];
  const inspectCalls: unknown[] = [];
  const reportedErrors: unknown[] = [];
  const coordinator = new FakeWindowCoordinator(
    options.linkWindow,
    options.unlinkWindow,
  );
  const inspectCoordinator = new BackgroundInspectCoordinator({
    async executeScript(details) {
      inspectCalls.push(["inject", details]);
      await options.executeScript?.(details);
    },
    async sendTabMessage(tabId, message) {
      inspectCalls.push(["tab", tabId, message]);
      await options.sendTabMessage?.(tabId, message);
    },
  });
  const harness = {
    coordinator,
    getTabCalls,
    inspectCalls,
    reportedErrors,
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
    onError: (error) => reportedErrors.push(error),
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
  public readonly links: Array<{
    windowId: number;
    code: string;
    source: unknown;
  }> = [];
  public readonly unlinks: number[] = [];
  public disposeCalls = 0;
  private readonly active = new Set<PanelRegistration>();

  public constructor(
    private readonly linkBehavior?: (
      windowId: number,
      code: string,
      source: unknown,
      signal?: AbortSignal,
    ) => Promise<void>,
    private readonly unlinkBehavior?: (
      windowId: number,
      signal?: AbortSignal,
    ) => Promise<void>,
  ) {}

  public async linkWindow(
    windowId: number,
    code: string,
    source: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    this.links.push({ windowId, code, source });
    await this.linkBehavior?.(windowId, code, source, signal);
  }

  public async unlinkWindow(
    windowId: number,
    signal?: AbortSignal,
  ): Promise<void> {
    this.unlinks.push(windowId);
    await this.unlinkBehavior?.(windowId, signal);
  }

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

function inspectResults(port: FakePort): unknown[] {
  return port.sent.filter(
    (message) =>
      isRecord(message) && message.type === "browser2ide.inspect.result",
  );
}

function createRouterSubscriptionHarness(): {
  readonly subscriptions: BackgroundRouterSubscriptions;
  detach(tabId: number, oldWindowId: number): void;
  attach(tabId: number, newWindowId: number): void;
} {
  let detached: ((tabId: number, oldWindowId: number) => void) | undefined;
  let attached: ((tabId: number, newWindowId: number) => void) | undefined;
  return {
    subscriptions: {
      subscribeRuntimeMessages() {
        return () => {};
      },
      subscribeRuntimePorts() {
        return () => {};
      },
      subscribeWindowRemoved() {
        return () => {};
      },
      subscribeTabDetached(listener) {
        detached = listener;
        return () => {
          if (detached === listener) {
            detached = undefined;
          }
        };
      },
      subscribeTabAttached(listener) {
        attached = listener;
        return () => {
          if (attached === listener) {
            attached = undefined;
          }
        };
      },
    },
    detach(tabId, oldWindowId) {
      if (!detached) {
        throw new Error("Missing tab detach listener");
      }
      detached(tabId, oldWindowId);
    },
    attach(tabId, newWindowId) {
      if (!attached) {
        throw new Error("Missing tab attach listener");
      }
      attached(tabId, newWindowId);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
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
