import browser from "webextension-polyfill";
import {
  createInspectPayload,
  InspectMode,
  type CssDocumentSource,
  type InspectDocument,
  type InspectableElement,
} from "@browser2ide/browser-extension-core";
import { ContentInspectLease } from "./inspectLease.js";
import { INSPECT_CONTENT_LEASE_PORT_NAME } from "./inspectPortProtocol.js";

interface ContentScriptState {
  readonly mode: InspectMode;
  readonly lease: ContentInspectLease;
}

const globalState = globalThis as typeof globalThis & {
  __browser2ideContentScript?: ContentScriptState;
};

if (!globalState.__browser2ideContentScript) {
  const mode = new InspectMode({
    document: document as unknown as InspectDocument,
    onSelect: sendSelection,
    onError: (error) =>
      void browser.runtime.sendMessage({
        type: "contentScriptError",
        message: messageOf(error),
      }),
  });
  const lease = new ContentInspectLease(mode, () =>
    browser.runtime.connect({ name: INSPECT_CONTENT_LEASE_PORT_NAME }),
  );
  browser.runtime.onMessage.addListener((message: unknown) => {
    if (!isRecord(message)) {
      return undefined;
    }
    if (message.type === "enableInspectMode") {
      lease.enable();
    } else if (message.type === "disableInspectMode") {
      lease.disable();
    }
    return undefined;
  });
  globalState.__browser2ideContentScript = { mode, lease };
}

async function sendSelection(element: InspectableElement): Promise<void> {
  const pageUrl = location.href;
  await browser.runtime.sendMessage({
    type: "elementSelected",
    payload: createInspectPayload(
      element,
      {
        pageUrl,
        styleSheets: document.styleSheets,
      } as unknown as CssDocumentSource,
      location,
    ),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
