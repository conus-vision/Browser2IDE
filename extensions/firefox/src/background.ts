import browser from "webextension-polyfill";
import {
  sanitizeErrorMessage,
  startBackgroundRuntime,
  type BackgroundMessageSender,
  type BackgroundRuntimePort,
} from "@browser2ide/browser-extension-core";

startBackgroundRuntime({
  expectedDevtoolsUrl: browser.runtime.getURL("dist/devtools.html"),
  expectedPanelUrl: browser.runtime.getURL("dist/panel.html"),
  storage: {
    get: (key) => browser.storage.session.get(key),
    set: (values) => browser.storage.session.set(values),
    remove: (key) => browser.storage.session.remove(key),
  },
  executeScript: (details) => browser.scripting.executeScript(details),
  sendTabMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
  getTab: async (tabId) => {
    const tab = await browser.tabs.get(tabId);
    return { id: tab.id, windowId: tab.windowId };
  },
  subscribeRuntimeMessages(listener) {
    const wrapped = (message: unknown, sender: FirefoxMessageSender) =>
      listener(message, adaptSender(sender));
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
  onError: (error) =>
    console.error("Browser2IDE background:", sanitizeErrorMessage(error)),
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
