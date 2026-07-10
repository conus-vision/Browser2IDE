import browser from "webextension-polyfill";
import {
  collectCssFacts,
  type CssDocumentSource,
} from "./collectCssFacts.js";
import { createElementSnapshot } from "./elementSnapshot.js";
import {
  InspectMode,
  type InspectDocument,
  type InspectableElement,
} from "./inspectMode.js";

interface ContentScriptState {
  readonly mode: InspectMode;
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
  browser.runtime.onMessage.addListener((message: unknown) => {
    if (!isRecord(message)) {
      return undefined;
    }
    if (message.type === "enableInspectMode") {
      mode.enable();
    } else if (message.type === "disableInspectMode") {
      mode.disable();
    }
    return undefined;
  });
  globalState.__browser2ideContentScript = { mode };
}

async function sendSelection(element: InspectableElement): Promise<void> {
  const pageUrl = location.href;
  const collection = collectCssFacts(element, {
    pageUrl,
    styleSheets: document.styleSheets,
  } as unknown as CssDocumentSource);
  await browser.runtime.sendMessage({
    type: "elementSelected",
    payload: {
      subject: createElementSnapshot(element, pageUrl),
      facts: collection.facts,
      context: {
        url: pageUrl,
        route: `${location.pathname}${location.search}${location.hash}`,
        metadata: {
          inaccessibleStylesheetCount:
            collection.inaccessibleStylesheets.length,
        },
      },
      metadata: {},
      inaccessibleStylesheets: collection.inaccessibleStylesheets,
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
