import browser from "webextension-polyfill";
import { createBackgroundRouter } from "./backgroundRouter.js";

const route = createBackgroundRouter({
  executeScript: (details) => browser.scripting.executeScript(details),
  sendTabMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
  sendRuntimeMessage: (message) => browser.runtime.sendMessage(message),
});

browser.runtime.onMessage.addListener(
  (message: unknown, sender: { tab?: { id?: number } }) =>
    route(message, { tabId: sender.tab?.id }),
);
