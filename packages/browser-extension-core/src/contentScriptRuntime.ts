import type { CssDocumentSource } from "./collectCssFacts.js";
import { createInspectPayload, type LocationSource } from "./inspectPayload.js";
import {
  INSPECT_CONTENT_LEASE_PORT_NAME,
  type ContentInspectPort,
} from "./inspectPortProtocol.js";
import {
  InspectMode,
  type InspectableElement,
  type InspectDocument,
} from "./inspectMode.js";
import { ContentInspectLease } from "./inspectLease.js";

const CONTENT_RUNTIME_KEY = Symbol.for("browser2ide.contentScriptRuntime");
const CONTENT_RUNTIME_BRAND = Symbol.for("browser2ide.contentScriptRuntime.brand");

export type ContentScriptDocument = InspectDocument & {
  readonly styleSheets: CssDocumentSource["styleSheets"];
};

export interface ContentScriptRuntimeOptions {
  readonly globalScope: object;
  readonly document: ContentScriptDocument;
  readonly location: LocationSource;
  readonly connectRuntimePort: (name: string) => ContentInspectPort;
  readonly sendRuntimeMessage: (message: unknown) => Promise<unknown>;
  readonly subscribeRuntimeMessages: (
    listener: (message: unknown) => void,
  ) => () => void;
  readonly onError?: (error: unknown) => void;
}

export interface ContentScriptRuntime {
  dispose(): void;
}

type BrandedContentScriptRuntime = ContentScriptRuntime & {
  readonly [CONTENT_RUNTIME_BRAND]: true;
};

type ContentRuntimeScope = object & {
  [CONTENT_RUNTIME_KEY]?: unknown;
};

export function startContentScriptRuntime(
  options: ContentScriptRuntimeOptions,
): ContentScriptRuntime {
  const scope = options.globalScope as ContentRuntimeScope;
  const existing = scope[CONTENT_RUNTIME_KEY];
  if (isContentScriptRuntime(existing)) {
    return existing;
  }

  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Diagnostics cannot break content-script ownership.
    }
  };
  const mode = new InspectMode({
    document: options.document,
    onSelect: (element) => publishSelection(options, element),
    onError: reportError,
  });
  const lease = new ContentInspectLease(mode, () =>
    options.connectRuntimePort(INSPECT_CONTENT_LEASE_PORT_NAME),
  );
  let disposed = false;
  const removeRuntimeMessages = options.subscribeRuntimeMessages((message) => {
    if (disposed) {
      return;
    }
    const enabled = parseInspectModeMessage(message);
    if (enabled === undefined) {
      return;
    }
    try {
      if (enabled) {
        lease.enable();
      } else {
        lease.disable();
      }
    } catch (error) {
      reportError(error);
    }
  });

  const runtime: BrandedContentScriptRuntime = {
    [CONTENT_RUNTIME_BRAND]: true,
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      removeRuntimeMessages();
      try {
        lease.disable();
      } catch (error) {
        reportError(error);
      }
      mode.dispose();
      if (scope[CONTENT_RUNTIME_KEY] === runtime) {
        delete scope[CONTENT_RUNTIME_KEY];
      }
    },
  };
  scope[CONTENT_RUNTIME_KEY] = runtime;
  return runtime;
}

async function publishSelection(
  options: ContentScriptRuntimeOptions,
  element: InspectableElement,
): Promise<void> {
  await options.sendRuntimeMessage({
    type: "elementSelected",
    payload: createInspectPayload(
      element,
      {
        pageUrl: options.location.href,
        styleSheets: options.document.styleSheets,
      },
      options.location,
    ),
  });
}

function parseInspectModeMessage(value: unknown): boolean | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 1) {
    return undefined;
  }
  if (value.type === "enableInspectMode") {
    return true;
  }
  if (value.type === "disableInspectMode") {
    return false;
  }
  return undefined;
}

function isContentScriptRuntime(
  value: unknown,
): value is BrandedContentScriptRuntime {
  return (
    Boolean(value && typeof value === "object") &&
    (value as Partial<BrandedContentScriptRuntime>)[CONTENT_RUNTIME_BRAND] === true &&
    typeof (value as Partial<BrandedContentScriptRuntime>).dispose === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
