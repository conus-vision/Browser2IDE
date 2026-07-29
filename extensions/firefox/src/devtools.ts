import browser from "webextension-polyfill";
import { registerDevtoolsPanel } from "@browser2ide/browser-extension-core";

const channelId = globalThis.crypto.randomUUID();
const sourceId = `firefox-${globalThis.crypto.randomUUID()}`;
let disposed = false;
let registration: { dispose(): void } | undefined;

window.addEventListener("unload", () => {
  disposed = true;
  registration?.dispose();
});

void registerDevtoolsPanel({
  inspectedTabId: browser.devtools.inspectedWindow.tabId,
  channelId,
  sourceId,
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
}).then(
  (created) => {
    if (disposed) {
      created.dispose();
    } else {
      registration = created;
    }
  },
  (error) => console.error("Browser2IDE DevTools:", error),
);
