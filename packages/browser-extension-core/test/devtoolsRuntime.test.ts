import { describe, expect, it } from "vitest";
import { registerDevtoolsPanel } from "../src/devtoolsRuntime.js";

describe("registerDevtoolsPanel", () => {
  it("registers a trusted source and re-announces it for panel recovery", async () => {
    let onShown: (() => void) | undefined;
    let runtimeListener: ((message: unknown) => void) | undefined;
    const removed: string[] = [];
    const sent: unknown[] = [];
    const created: unknown[] = [];
    const registration = await registerDevtoolsPanel({
      inspectedTabId: 42,
      channelId: "channel-1",
      sourceId: "firefox-source-1",
      async createPanel(title, icon, page) {
        created.push({ title, icon, page });
        return {
          addShownListener: (listener) => (onShown = listener),
          removeShownListener: () => removed.push("shown"),
        };
      },
      addRuntimeMessageListener(listener) {
        runtimeListener = listener;
        return () => removed.push("runtime");
      },
      async sendRuntimeMessage(message) {
        sent.push(message);
      },
    });

    expect(created).toEqual([
      {
        title: "Browser2IDE",
        icon: "/dist/browser2ide.svg",
        page: "/dist/panel.html?channel=channel-1",
      },
    ]);
    expect(sent).toEqual([
      {
        type: "browser2ide.registerDevtools",
        channel: "channel-1",
        tabId: 42,
        sourceId: "firefox-source-1",
      },
    ]);
    runtimeListener?.({ type: "browser2ide.panelReady", channel: "other" });
    runtimeListener?.({
      type: "browser2ide.panelReady",
      channel: "channel-1",
    });
    onShown?.();
    expect(sent).toEqual([
      {
        type: "browser2ide.registerDevtools",
        channel: "channel-1",
        tabId: 42,
        sourceId: "firefox-source-1",
      },
      {
        type: "browser2ide.registerDevtools",
        channel: "channel-1",
        tabId: 42,
        sourceId: "firefox-source-1",
      },
      {
        type: "browser2ide.registerDevtools",
        channel: "channel-1",
        tabId: 42,
        sourceId: "firefox-source-1",
      },
    ]);

    registration.dispose();
    expect(removed).toEqual(["shown", "runtime"]);
  });

  it("removes its runtime listener when panel creation fails", async () => {
    const removed: string[] = [];

    await expect(
      registerDevtoolsPanel({
        inspectedTabId: 42,
        channelId: "channel-1",
        sourceId: "firefox-source-1",
        async createPanel() {
          throw new Error("panel unavailable");
        },
        addRuntimeMessageListener() {
          return () => removed.push("runtime");
        },
        async sendRuntimeMessage() {},
      }),
    ).rejects.toThrow("panel unavailable");

    expect(removed).toEqual(["runtime"]);
  });
});
