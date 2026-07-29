import browser from "webextension-polyfill";
import {
  BackgroundInspectCoordinator,
  BrowserWindowLinkStore,
  createBackgroundRouter,
  WindowConnectionCoordinator,
  type BackgroundMessageSender,
  type BackgroundRuntimePort,
} from "@browser2ide/browser-extension-core";

const inspectCoordinator = new BackgroundInspectCoordinator({
  executeScript: (details) => browser.scripting.executeScript(details),
  sendTabMessage: (tabId, message) =>
    browser.tabs.sendMessage(tabId, message),
});
const linkStore = new BrowserWindowLinkStore({
  get: (key) => browser.storage.session.get(key),
  set: (values) => browser.storage.session.set(values),
  remove: (key) => browser.storage.session.remove(key),
});
const coordinator = new WindowConnectionCoordinator({ store: linkStore });

createBackgroundRouter({
  expectedDevtoolsUrl: browser.runtime.getURL("dist/devtools.html"),
  expectedPanelUrl: browser.runtime.getURL("dist/panel.html"),
  getTab: async (tabId) => {
    const tab = await browser.tabs.get(tabId);
    return { id: tab.id, windowId: tab.windowId };
  },
  coordinator,
  inspectCoordinator,
  subscriptions: {
    subscribeRuntimeMessages(listener) {
      const wrapped = (
        message: unknown,
        sender: FirefoxMessageSender,
      ) => listener(message, adaptSender(sender));
      browser.runtime.onMessage.addListener(wrapped);
      return () => browser.runtime.onMessage.removeListener(wrapped);
    },
    subscribeRuntimePorts(listener) {
      const wrapped = (port: FirefoxRuntimePort): void => {
        listener(port as unknown as BackgroundRuntimePort);
      };
      browser.runtime.onConnect.addListener(wrapped);
      return () => browser.runtime.onConnect.removeListener(wrapped);
    },
    subscribeWindowRemoved(listener) {
      browser.windows.onRemoved.addListener(listener);
      return () => browser.windows.onRemoved.removeListener(listener);
    },
  },
  onError: (error) =>
    console.error("Browser2IDE background:", messageOf(error)),
});

interface FirefoxMessageSender {
  readonly url?: string;
  readonly tab?: {
    readonly id?: number;
    readonly windowId?: number;
  };
}

interface FirefoxRuntimePort {
  readonly name: string;
  readonly sender?: FirefoxMessageSender;
}

function adaptSender(sender: FirefoxMessageSender): BackgroundMessageSender {
  return {
    url: sender.url,
    tab: sender.tab
      ? { id: sender.tab.id, windowId: sender.tab.windowId }
      : undefined,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
