import browser from "webextension-polyfill";
import { registerDevtoolsPanel } from "./devtoolsRuntime.js";

const channelId = globalThis.crypto.randomUUID();

void registerDevtoolsPanel({
  inspectedTabId: browser.devtools.inspectedWindow.tabId,
  channelId,
  async createPanel(title, icon, page) {
    const panel = await browser.devtools.panels.create(title, icon, page);
    return {
      addShownListener: (listener) => panel.onShown.addListener(listener),
      removeShownListener: (listener) => panel.onShown.removeListener(listener),
    };
  },
  addRuntimeMessageListener(listener) {
    const wrapped = (message: unknown): void => listener(message);
    browser.runtime.onMessage.addListener(wrapped);
    return () => browser.runtime.onMessage.removeListener(wrapped);
  },
  sendRuntimeMessage: (message) => browser.runtime.sendMessage(message),
  onError: (error) => console.error("Browser2IDE DevTools:", error),
}).catch((error) => console.error("Browser2IDE DevTools:", error));
