import { describe, expect, it, vi } from "vitest";
import { startContentScriptRuntime } from "../src/contentScriptRuntime.js";

describe("startContentScriptRuntime", () => {
  it("is idempotent, owns the inspect lease, and cleans up listeners", async () => {
    const runtimeMessages = messageHarness();
    const leasePort = portHarness();
    const document = documentHarness();
    const globalScope = {};
    const sent: unknown[] = [];
    const options = {
      globalScope,
      document: document.document,
      location: locationSource(),
      connectRuntimePort: vi.fn(() => leasePort.port),
      sendRuntimeMessage: vi.fn(async (message: unknown) => {
        sent.push(message);
      }),
      subscribeRuntimeMessages: runtimeMessages.subscribe,
    };

    const first = startContentScriptRuntime(options);
    const second = startContentScriptRuntime(options);
    expect(second).toBe(first);
    expect(runtimeMessages.subscribe).toHaveBeenCalledOnce();

    runtimeMessages.emit({ type: "enableInspectMode" });
    expect(options.connectRuntimePort).toHaveBeenCalledWith(
      "browser2ide.inspect.contentLease",
    );
    expect(document.captureAdds).toEqual([true]);

    document.click(inspectableElement());
    await flushAsync();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "elementSelected",
      payload: {
        context: { url: "https://example.test/page" },
        targets: [{ role: "selected" }],
      },
    });

    leasePort.disconnect();
    expect(document.captureRemoves).toEqual([true]);

    first.dispose();
    first.dispose();
    expect(runtimeMessages.remove).toHaveBeenCalledOnce();
    expect(leasePort.remove).toHaveBeenCalledOnce();

    const restarted = startContentScriptRuntime(options);
    expect(restarted).not.toBe(first);
    restarted.dispose();
  });

  it("reports selection transport failures without leaking an unhandled rejection", async () => {
    const runtimeMessages = messageHarness();
    const document = documentHarness();
    const reported: unknown[] = [];
    const runtime = startContentScriptRuntime({
      globalScope: {},
      document: document.document,
      location: locationSource(),
      connectRuntimePort: () => portHarness().port,
      sendRuntimeMessage: async () => {
        throw new Error("runtime unavailable");
      },
      subscribeRuntimeMessages: runtimeMessages.subscribe,
      onError: (error) => reported.push(error),
    });

    runtimeMessages.emit({ type: "enableInspectMode" });
    document.click(inspectableElement());
    await flushAsync();
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBeInstanceOf(Error);
    runtime.dispose();
  });
});

function messageHarness() {
  let listener: ((message: unknown) => void) | undefined;
  const remove = vi.fn();
  return {
    subscribe: vi.fn((next: (message: unknown) => void) => {
      listener = next;
      return remove;
    }),
    remove,
    emit(message: unknown) {
      listener?.(message);
    },
  };
}

function portHarness() {
  let listener: (() => void) | undefined;
  const remove = vi.fn(() => {
    listener = undefined;
  });
  return {
    port: {
      onDisconnect: {
        addListener(next: () => void) {
          listener = next;
        },
        removeListener: remove,
      },
      disconnect: vi.fn(),
    },
    remove,
    disconnect() {
      listener?.();
    },
  };
}

function documentHarness() {
  let clickListener: ((event: unknown) => void) | undefined;
  const captureAdds: boolean[] = [];
  const captureRemoves: boolean[] = [];
  return {
    document: {
      styleSheets: [],
      addEventListener(
        _type: string,
        listener: (event: unknown) => void,
        capture: boolean,
      ) {
        clickListener = listener;
        captureAdds.push(capture);
      },
      removeEventListener(
        _type: string,
        listener: (event: unknown) => void,
        capture: boolean,
      ) {
        if (clickListener === listener) {
          clickListener = undefined;
        }
        captureRemoves.push(capture);
      },
    },
    captureAdds,
    captureRemoves,
    click(target: unknown) {
      clickListener?.({
        target,
        preventDefault() {},
        stopPropagation() {},
        stopImmediatePropagation() {},
      });
    },
  };
}

function inspectableElement() {
  return {
    tagName: "ARTICLE",
    id: "hero",
    classList: ["card"],
    attributes: [],
    parentElement: null,
    matches: () => false,
  };
}

function locationSource() {
  return {
    href: "https://example.test/page",
    pathname: "/page",
    search: "",
    hash: "",
  };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}
