import browser from "webextension-polyfill";
import {
  sanitizeErrorMessage,
  startContentScriptRuntime,
  type ContentInspectPort,
  type ContentScriptDocument,
} from "@browser2ide/browser-extension-core";

startContentScriptRuntime({
  globalScope: globalThis,
  document: document as unknown as ContentScriptDocument,
  location,
  connectRuntimePort: (name) =>
    browser.runtime.connect({ name }) as unknown as ContentInspectPort,
  sendRuntimeMessage: (message) => browser.runtime.sendMessage(message),
  subscribeRuntimeMessages(listener) {
    const wrapped = (message: unknown): void => listener(message);
    browser.runtime.onMessage.addListener(wrapped);
    return () => browser.runtime.onMessage.removeListener(wrapped);
  },
  onError: (error) =>
    console.error("Browser2IDE content script:", sanitizeErrorMessage(error)),
});
