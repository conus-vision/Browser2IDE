import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => unknown;

const harness = vi.hoisted(() => {
  const event = () => ({
    addListener: vi.fn<(listener: Listener) => void>(),
    removeListener: vi.fn<(listener: Listener) => void>(),
  });
  const runtimeMessage = event();
  const runtimeConnect = event();
  const windowRemoved = event();
  const panelShown = event();
  const runtimePort = {
    name: "browser2ide.devtools.test-channel",
    onMessage: event(),
    onDisconnect: event(),
    postMessage: vi.fn(),
    disconnect: vi.fn(),
  };

  return {
    starts: {
      background: vi.fn(() => ({ dispose: vi.fn() })),
      contentScript: vi.fn(() => ({ dispose: vi.fn() })),
      devtools: vi.fn(() => ({ dispose: vi.fn() })),
      panel: vi.fn(() => ({ dispose: vi.fn() })),
    },
    sanitize: vi.fn((_error: unknown) => "sanitized error"),
    runtimeMessage,
    runtimeConnect,
    windowRemoved,
    panelShown,
    runtimePort,
    browser: {
      scripting: {
        executeScript: vi.fn(async (_details: unknown) => []),
      },
      tabs: {
        get: vi.fn(async (tabId: number) => ({
          id: tabId,
          windowId: 17,
          title: "must not cross the adapter",
        })),
        sendMessage: vi.fn(async (_tabId: number, _message: unknown) => undefined),
      },
      storage: {
        session: {
          get: vi.fn(async (_key: string) => ({})),
          set: vi.fn(async (_values: Record<string, unknown>) => undefined),
          remove: vi.fn(async (_key: string) => undefined),
        },
      },
      runtime: {
        getURL: vi.fn((path: string) => `chrome-extension://browser2ide/${path}`),
        sendMessage: vi.fn(async (_message: unknown) => undefined),
        connect: vi.fn((_options: { name: string }) => runtimePort),
        onMessage: runtimeMessage,
        onConnect: runtimeConnect,
      },
      windows: {
        onRemoved: windowRemoved,
      },
      devtools: {
        inspectedWindow: { tabId: 91 },
        panels: {
          create: vi.fn(async () => ({ onShown: panelShown })),
        },
      },
    },
  };
});

vi.mock("webextension-polyfill", () => ({ default: harness.browser }));

vi.mock("@browser2ide/browser-extension-core", () => ({
  startBackgroundRuntime: harness.starts.background,
  startContentScriptRuntime: harness.starts.contentScript,
  startDevtoolsRuntime: harness.starts.devtools,
  startPanelRuntime: harness.starts.panel,
  sanitizeErrorMessage: harness.sanitize,
}));

describe("Chrome platform adapters", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    installBrowserGlobals();
  });

  afterEach(() => {
    consoleError.mockRestore();
    delete (
      globalThis as typeof globalThis & {
        __browser2ideContentScript?: unknown;
      }
    ).__browser2ideContentScript;
    vi.unstubAllGlobals();
  });

  it("starts the shared background runtime through narrow Chrome wrappers", async () => {
    await import("../src/background.js");

    expect(harness.starts.background).toHaveBeenCalledOnce();
    const options = calledOptions(harness.starts.background);
    expect(options.expectedDevtoolsUrl).toBe(
      "chrome-extension://browser2ide/dist/devtools.html",
    );
    expect(options.expectedPanelUrl).toBe(
      "chrome-extension://browser2ide/dist/panel.html",
    );

    const storage = options.storage as Record<string, unknown>;
    await callAsync(storage.get, "window-link.17");
    await callAsync(storage.set, { "window-link.17": { port: 48735 } });
    await callAsync(storage.remove, "window-link.17");
    expect(harness.browser.storage.session.get).toHaveBeenCalledWith(
      "window-link.17",
    );
    expect(harness.browser.storage.session.set).toHaveBeenCalledWith({
      "window-link.17": { port: 48735 },
    });
    expect(harness.browser.storage.session.remove).toHaveBeenCalledWith(
      "window-link.17",
    );

    await callAsync(options.executeScript, {
      target: { tabId: 91 },
      files: ["dist/contentScript.js"],
    });
    await callAsync(options.sendTabMessage, 91, { type: "enableInspectMode" });
    await expect(callAsync(options.getTab, 91)).resolves.toEqual({
      id: 91,
      windowId: 17,
    });

    const runtimeListener = vi.fn();
    const removeRuntime = call(options.subscribeRuntimeMessages, runtimeListener);
    const wrappedRuntime = harness.runtimeMessage.addListener.mock.calls[0]?.[0];
    const registration = { type: "browser2ide.registerDevtools" };
    await callAsync(wrappedRuntime, registration, {
      url: "chrome-extension://browser2ide/dist/devtools.html",
      tab: { id: 91, windowId: 17, title: "not forwarded" },
      frameId: 5,
    });
    expect(runtimeListener).toHaveBeenCalledWith(registration, {
      url: "chrome-extension://browser2ide/dist/devtools.html",
      tab: { id: 91, windowId: 17 },
    });
    call(removeRuntime);
    expect(harness.runtimeMessage.removeListener).toHaveBeenCalledOnce();

    const portListener = vi.fn();
    const removePorts = call(options.subscribeRuntimePorts, portListener);
    const removeWindows = call(options.subscribeWindowRemoved, vi.fn());
    const wrappedPort = harness.runtimeConnect.addListener.mock.calls[0]?.[0];
    call(wrappedPort, harness.runtimePort);
    expect(portListener).toHaveBeenCalledWith(harness.runtimePort);
    call(removePorts);
    call(removeWindows);
    expect(harness.runtimeConnect.removeListener).toHaveBeenCalledOnce();
    expect(harness.windowRemoved.removeListener).toHaveBeenCalledOnce();

    const secret = new Error("secret background stack");
    call(options.onError, secret);
    expectSanitizedLog(consoleError, "background", secret);
  });

  it("starts the shared content runtime through narrow Chrome wrappers", async () => {
    await import("../src/contentScript.js");

    expect(harness.starts.contentScript).toHaveBeenCalledOnce();
    const options = calledOptions(harness.starts.contentScript);
    expect(options.document).toBe(globalThis.document);
    expect(options.location).toBe(globalThis.location);
    expect(options.globalScope).toBe(globalThis);

    call(options.connectRuntimePort, "browser2ide.inspect.contentLease");
    expect(harness.browser.runtime.connect).toHaveBeenCalledWith({
      name: "browser2ide.inspect.contentLease",
    });
    await callAsync(options.sendRuntimeMessage, { type: "elementSelected" });
    expect(harness.browser.runtime.sendMessage).toHaveBeenCalledWith({
      type: "elementSelected",
    });

    const listener = vi.fn();
    const remove = call(options.subscribeRuntimeMessages, listener);
    const wrapped = harness.runtimeMessage.addListener.mock.calls[0]?.[0];
    call(wrapped, { type: "enableInspectMode" }, { ignored: true });
    expect(listener).toHaveBeenCalledWith({ type: "enableInspectMode" });
    call(remove);
    expect(harness.runtimeMessage.removeListener).toHaveBeenCalledOnce();

    const secret = new Error("secret content stack");
    call(options.onError, secret);
    expectSanitizedLog(consoleError, "content script", secret);
  });

  it("starts the shared DevTools runtime with a Chrome source prefix", async () => {
    await import("../src/devtools.js");

    expect(harness.starts.devtools).toHaveBeenCalledOnce();
    const options = calledOptions(harness.starts.devtools);
    expect(options.inspectedTabId).toBe(91);
    expect(options.sourcePrefix).toBe("chrome");
    expect(call(options.createId)).toBe("test-runtime-id");

    await callAsync(
      options.createPanel,
      "Browser2IDE",
      "/dist/browser2ide.svg",
      "/dist/panel.html?channel=test",
    );
    expect(harness.browser.devtools.panels.create).toHaveBeenCalledOnce();
    const removeMessages = call(options.subscribeRuntimeMessages, vi.fn());
    const removeUnload = call(options.subscribeUnload, vi.fn());
    call(removeMessages);
    call(removeUnload);
    expect(harness.runtimeMessage.removeListener).toHaveBeenCalledOnce();
    expect(globalEvents.removeEventListener).toHaveBeenCalledWith(
      "unload",
      expect.any(Function),
    );

    const secret = new Error("secret DevTools stack");
    call(options.onError, secret);
    expectSanitizedLog(consoleError, "DevTools", secret);
  });

  it("starts the shared panel runtime without eager clipboard access", async () => {
    await import("../src/panel.js");

    expect(harness.starts.panel).toHaveBeenCalledOnce();
    expect(clipboard.readText).not.toHaveBeenCalled();
    const options = calledOptions(harness.starts.panel);
    expect(options.locationSearch).toBe("?channel=test-channel");
    expect(options.document).toBe(globalThis.document);

    call(options.connectRuntimePort, "browser2ide.devtools.test-channel");
    expect(harness.browser.runtime.connect).toHaveBeenCalledWith({
      name: "browser2ide.devtools.test-channel",
    });
    await callAsync(options.readClipboard);
    expect(clipboard.readText).toHaveBeenCalledOnce();
    const removeUnload = call(options.subscribeUnload, vi.fn());
    call(removeUnload);
    expect(globalEvents.removeEventListener).toHaveBeenCalledWith(
      "unload",
      expect.any(Function),
    );

    const secret = new Error("secret panel stack");
    call(options.onError, secret);
    expectSanitizedLog(consoleError, "panel", secret);
  });

  it("keeps webextension-polyfill out of every shared core source file", () => {
    const sourceDirectory = new URL(
      "../../../packages/browser-extension-core/src/",
      import.meta.url,
    );
    for (const name of readdirSync(sourceDirectory)) {
      if (!name.endsWith(".ts")) {
        continue;
      }
      expect(readFileSync(new URL(name, sourceDirectory), "utf8")).not.toContain(
        "webextension-polyfill",
      );
    }
  });
});

const globalEvents = {
  addEventListener: vi.fn<(type: string, listener: Listener) => void>(),
  removeEventListener: vi.fn<(type: string, listener: Listener) => void>(),
};

const clipboard = {
  readText: vi.fn(async () => "4873507"),
};

function installBrowserGlobals(): void {
  globalEvents.addEventListener.mockReset();
  globalEvents.removeEventListener.mockReset();
  clipboard.readText.mockClear();
  const elements = new Map<string, FakeElement>();
  vi.stubGlobal("window", globalEvents);
  vi.stubGlobal("document", {
    styleSheets: [],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getElementById(id: string) {
      const existing = elements.get(id);
      if (existing) {
        return existing;
      }
      const created = new FakeElement();
      elements.set(id, created);
      return created;
    },
  });
  vi.stubGlobal("location", {
    href: "https://example.test/page",
    origin: "https://example.test",
    pathname: "/page",
    search: "?channel=test-channel",
    hash: "",
  });
  vi.stubGlobal("navigator", { clipboard });
  vi.stubGlobal("crypto", { randomUUID: () => "test-runtime-id" });
}

class FakeElement {
  public value = "";
  public checked = false;
  public disabled = false;
  public hidden = false;
  public readonly dataset: Record<string, string> = {};
  public addEventListener(): void {}
  public removeEventListener(): void {}
}

function calledOptions(mock: ReturnType<typeof vi.fn>): Record<string, any> {
  const options = mock.mock.calls[0]?.[0];
  expect(options).toBeDefined();
  return options as Record<string, any>;
}

function expectSanitizedLog(
  consoleError: ReturnType<typeof vi.spyOn>,
  scope: string,
  secret: Error,
): void {
  expect(harness.sanitize).toHaveBeenCalledWith(secret);
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining(scope),
    "sanitized error",
  );
  expect(consoleError.mock.calls.flat()).not.toContain(secret);
}

function call(value: unknown, ...args: unknown[]): any {
  expect(value).toBeTypeOf("function");
  return (value as (...callArgs: unknown[]) => unknown)(...args);
}

async function callAsync(value: unknown, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve(call(value, ...args));
}
