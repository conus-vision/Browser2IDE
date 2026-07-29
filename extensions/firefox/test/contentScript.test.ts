import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RuntimeMessageListener = (message: unknown) => unknown;

const harness = vi.hoisted(() => ({
  runtimeListeners: [] as RuntimeMessageListener[],
  disconnectListeners: [] as Array<() => void>,
  connect: vi.fn(),
  sendMessage: vi.fn(async (_message: unknown) => undefined),
}));

vi.mock("webextension-polyfill", () => ({
  default: {
    runtime: {
      connect: (options: { name: string }) => harness.connect(options),
      sendMessage: (message: unknown) => harness.sendMessage(message),
      onMessage: {
        addListener: (listener: RuntimeMessageListener) => {
          harness.runtimeListeners.push(listener);
        },
      },
    },
  },
}));

describe("content script inspect lease", () => {
  let documentHarness: ReturnType<typeof installDocument>;

  beforeEach(() => {
    vi.resetModules();
    harness.runtimeListeners.length = 0;
    harness.disconnectListeners.length = 0;
    harness.connect.mockReset();
    harness.sendMessage.mockClear();
    harness.connect.mockReturnValue({
      onDisconnect: {
        addListener(listener: () => void) {
          harness.disconnectListeners.push(listener);
        },
        removeListener(listener: () => void) {
          const index = harness.disconnectListeners.indexOf(listener);
          if (index >= 0) {
            harness.disconnectListeners.splice(index, 1);
          }
        },
      },
      disconnect() {},
    });
    delete (
      globalThis as typeof globalThis & {
        __browser2ideContentScript?: unknown;
      }
    ).__browser2ideContentScript;
    documentHarness = installDocument();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("removes the capture listener immediately when its lease port disconnects", async () => {
    await import("../src/contentScript.js");
    const listener = harness.runtimeListeners[0];
    expect(listener).toBeDefined();

    listener?.({ type: "enableInspectMode" });

    expect(harness.connect).toHaveBeenCalledWith({
      name: "browser2ide.inspect.contentLease",
    });
    expect(documentHarness.registrations).toEqual([true]);

    for (const disconnect of [...harness.disconnectListeners]) {
      disconnect();
    }

    expect(documentHarness.removals).toEqual([true]);
  });
});

function installDocument(): {
  readonly registrations: boolean[];
  readonly removals: boolean[];
} {
  const registrations: boolean[] = [];
  const removals: boolean[] = [];
  const fakeDocument = {
    styleSheets: [],
    addEventListener(
      _type: string,
      _listener: (event: unknown) => void,
      capture: boolean,
    ) {
      registrations.push(capture);
    },
    removeEventListener(
      _type: string,
      _listener: (event: unknown) => void,
      capture: boolean,
    ) {
      removals.push(capture);
    },
  };
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("location", {
    href: "https://example.test/page",
    origin: "https://example.test",
    pathname: "/page",
  });
  return { registrations, removals };
}
