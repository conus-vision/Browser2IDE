import browser from "webextension-polyfill";
import { createBackgroundRouter } from "./backgroundRouter.js";
import {
  BackgroundInspectCoordinator,
  attachBackgroundInspectSession,
} from "./backgroundInspectSession.js";
import {
  INSPECT_CONTENT_LEASE_PORT_NAME,
  INSPECT_PORT_NAME,
} from "./inspectPortProtocol.js";

const route = createBackgroundRouter({
  sendRuntimeMessage: (message) => browser.runtime.sendMessage(message),
});

browser.runtime.onMessage.addListener(
  (message: unknown, sender: { tab?: { id?: number } }) =>
    route(message, { tabId: sender.tab?.id }),
);

const inspectCoordinator = new BackgroundInspectCoordinator({
  executeScript: (details) => browser.scripting.executeScript(details),
  sendTabMessage: (tabId, message) =>
    browser.tabs.sendMessage(tabId, message),
});

browser.runtime.onConnect.addListener((port) => {
  if (port.name === INSPECT_CONTENT_LEASE_PORT_NAME) {
    const tabId = port.sender?.tab?.id;
    if (tabId === undefined) {
      port.disconnect();
      return;
    }
    inspectCoordinator.attachContentLease(tabId, port);
    return;
  }
  if (port.name !== INSPECT_PORT_NAME) {
    return;
  }
  attachBackgroundInspectSession(port, inspectCoordinator);
});
