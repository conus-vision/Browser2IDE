import { describe, expect, it } from "vitest";
import {
  PanelController,
  type PanelActions,
  type PanelCommand,
  type PanelOperationalState,
  type PanelView,
  type PanelViewModel,
} from "../src/panelController.js";

describe("PanelController", () => {
  it("reads the clipboard only after the paste action and links the normalized code", async () => {
    const harness = createHarness({ clipboard: "48735 07" });

    await harness.controller.initialize();
    expect(harness.clipboardReads).toBe(0);

    await harness.view.actions.onPaste();

    expect(harness.clipboardReads).toBe(1);
    expect(harness.view.linkCode).toBe("");
    expect(harness.sent).toEqual([
      {
        type: "browser2ide.linkWindow",
        channel: "channel-1",
        code: "4873507",
      },
    ]);
    expect(harness.view.current.statusLabel).toBe("Linking");
  });

  it("clears the accepted link code only after the command succeeds", async () => {
    const response = deferred<unknown>();
    const harness = createHarness({ commandResponse: () => response.promise });
    await harness.controller.initialize();
    harness.view.editLinkCode("48735 07");

    const linking = harness.view.actions.onLink();
    await Promise.resolve();
    expect(harness.view.linkCode).not.toBe("");

    response.resolve({ ok: true });
    await linking;

    expect(harness.view.linkCode).toBe("");
  });

  it("clears the link code when connected arrives before command acceptance", async () => {
    const response = deferred<unknown>();
    const harness = createHarness({ commandResponse: () => response.promise });
    await harness.controller.initialize();
    harness.view.editLinkCode("4873507");

    const linking = harness.view.actions.onLink();
    await Promise.resolve();
    await harness.emitState("connected");

    expect(harness.view.linkCode).toBe("");
    response.resolve({ ok: true });
    await linking;
    expect(harness.view.linkCode).toBe("");
  });

  it("keeps the accepted code cleared when connected arrives after success", async () => {
    const harness = createHarness();
    await harness.controller.initialize();
    harness.view.editLinkCode("4873507");

    await harness.view.actions.onLink();
    expect(harness.view.linkCode).toBe("");

    await harness.emitState("connected");
    expect(harness.view.linkCode).toBe("");
  });

  it("keeps manual entry enabled when clipboard access is denied", async () => {
    const harness = createHarness({
      clipboardError: new Error("permission denied"),
    });
    await harness.controller.initialize();

    await harness.view.actions.onPaste();

    expect(harness.clipboardReads).toBe(1);
    expect(harness.sent).toEqual([]);
    expect(harness.view.current.linkInputDisabled).toBe(false);
    expect(harness.view.current.errorText).toBe(
      "Paste the seven-digit code manually",
    );
  });

  it("never enables inspect mode during initialization", async () => {
    const harness = createHarness();

    await harness.controller.initialize();

    expect(harness.inspect.calls).toEqual([]);
    expect(harness.view.current.inspectChecked).toBe(false);
    expect(harness.view.current.inspectDisabled).toBe(true);
  });

  it("supports manual entry and rejects an invalid code without messaging", async () => {
    const harness = createHarness();
    await harness.controller.initialize();
    harness.view.editLinkCode("48735 0x");

    await harness.view.actions.onLink();

    expect(harness.sent).toEqual([]);
    expect(harness.view.current.state).toBe("error");
    expect(harness.view.current.errorText).toBe(
      "Enter a valid seven-digit code",
    );
    expect(harness.view.current.linkInputDisabled).toBe(false);
    expect(harness.view.linkCode).toBe("48735 0x");
  });

  it.each<readonly [PanelOperationalState, string, boolean]>([
    ["notLinked", "Not linked", true],
    ["linking", "Linking", true],
    ["connected", "Connected", false],
    ["reconnecting", "Reconnecting", true],
    ["offline", "Linked IDE offline", true],
    ["rateLimited", "Rate limited", true],
    ["error", "Error", true],
  ])(
    "renders %s as %s",
    async (state, label, inspectDisabled) => {
      const harness = createHarness();
      await harness.controller.initialize();

      await harness.emitState(state);

      expect(harness.view.current.statusLabel).toBe(label);
      expect(harness.view.current.inspectDisabled).toBe(inspectDisabled);
    },
  );

  it("requires explicit change and unlink actions and disables inspect for both", async () => {
    const harness = createHarness();
    await harness.controller.initialize();
    await harness.emitState("connected");
    await harness.view.actions.onInspectChanged(true);
    expect(harness.inspect.enabled).toBe(true);

    await harness.view.actions.onChangeIde();

    expect(harness.inspect.enabled).toBe(false);
    expect(harness.view.current.showLinkControls).toBe(true);
    expect(harness.view.current.showConnectedControls).toBe(true);
    expect(harness.sent).toEqual([]);

    await harness.view.actions.onUnlink();

    expect(harness.sent).toEqual([
      {
        type: "browser2ide.unlinkWindow",
        channel: "channel-1",
      },
    ]);
    expect(harness.view.current.state).toBe("notLinked");
    expect(harness.view.current.inspectChecked).toBe(false);
  });

  it("disables inspect when the link is lost or inspect transport disconnects", async () => {
    const harness = createHarness();
    await harness.controller.initialize();
    await harness.emitState("connected");
    await harness.view.actions.onInspectChanged(true);

    await harness.emitState("reconnecting");

    expect(harness.inspect.enabled).toBe(false);
    expect(harness.view.current.inspectChecked).toBe(false);

    await harness.emitState("connected");
    await harness.view.actions.onInspectChanged(true);
    await harness.controller.handleTransportDisconnect();

    expect(harness.inspect.disconnectCalls).toBe(1);
    expect(harness.view.current.state).toBe("offline");
    expect(harness.view.current.showConnectedControls).toBe(true);
    expect(harness.view.current.inspectChecked).toBe(false);
  });

  it.each([
    {
      name: "invalid manual code",
      arrange: async (harness: ReturnType<typeof createHarness>) => {
        harness.view.editLinkCode("invalid");
        await harness.view.actions.onLink();
      },
      state: "error",
      error: "Enter a valid seven-digit code",
    },
    {
      name: "denied clipboard",
      arrange: async (harness: ReturnType<typeof createHarness>) => {
        await harness.view.actions.onPaste();
      },
      state: "error",
      error: "Paste the seven-digit code manually",
    },
  ])(
    "keeps an unlinked $name unlinked after transport disconnect",
    async ({ arrange, state, error }) => {
      const harness = createHarness({
        clipboardError: new Error("permission denied"),
      });
      await harness.controller.initialize();
      await arrange(harness);

      await harness.controller.handleTransportDisconnect();

      expect(harness.view.current.state).toBe(state);
      expect(harness.view.current.errorText).toBe(error);
      expect(harness.view.current.showConnectedControls).toBe(false);
    },
  );

  it.each([
    ["rateLimited", "Rate limited"],
    ["error", "Error"],
  ] as const)(
    "keeps an unlinked %s command failure unlinked after disconnect",
    async (error, expectedLabel) => {
      const harness = createHarness({
        commandResponse: async () => ({ ok: false, error }),
      });
      await harness.controller.initialize();
      harness.view.editLinkCode("4873507");
      await harness.view.actions.onLink();

      await harness.controller.handleTransportDisconnect();

      expect(harness.view.current.statusLabel).toBe(expectedLabel);
      expect(harness.view.current.showConnectedControls).toBe(false);
      expect(harness.view.linkCode).toBe("4873507");
    },
  );

  it.each(["linking", "connected", "reconnecting"] as const)(
    "keeps real %s link intent as offline after disconnect",
    async (state) => {
      const harness = createHarness();
      await harness.controller.initialize();
      await harness.emitState(state);

      await harness.controller.handleTransportDisconnect();

      expect(harness.view.current.state).toBe("offline");
      expect(harness.view.current.showConnectedControls).toBe(true);
    },
  );

  it("renders inspect failures without leaving the toggle enabled", async () => {
    const harness = createHarness({
      inspectError: new Error("Inspect connection is closed"),
    });
    await harness.controller.initialize();
    await harness.emitState("connected");

    await harness.view.actions.onInspectChanged(true);

    expect(harness.view.current.inspectChecked).toBe(false);
    expect(harness.view.current.errorText).toBe(
      "Inspect connection is unavailable",
    );
  });

  it("ignores a stale link response after change IDE", async () => {
    const link = deferred<unknown>();
    const harness = createHarness({ commandResponse: () => link.promise });
    await harness.controller.initialize();
    harness.view.editLinkCode("4873507");

    const pendingLink = harness.view.actions.onLink();
    await Promise.resolve();
    await harness.view.actions.onChangeIde();
    link.resolve({ ok: false, error: "rateLimited" });
    await pendingLink;

    expect(harness.view.current.showLinkControls).toBe(true);
    expect(harness.view.current.state).not.toBe("rateLimited");
    expect(harness.view.current.errorText).toBeUndefined();
  });

  it("sanitizes command failures into operational states", async () => {
    const harness = createHarness({
      commandResponse: async () => ({ ok: false, error: "rateLimited" }),
    });
    await harness.controller.initialize();
    harness.view.editLinkCode("4873507");

    await harness.view.actions.onLink();

    expect(harness.view.current.state).toBe("rateLimited");
    expect(harness.view.current.statusLabel).toBe("Rate limited");
    expect(harness.view.current.errorText).toBe(
      "Too many attempts. Try again in one minute.",
    );
    expect(harness.view.linkCode).toBe("4873507");
  });

  it("disposes the view and state subscription once", async () => {
    const harness = createHarness();
    await harness.controller.initialize();

    await harness.controller.dispose();
    await harness.controller.dispose();

    expect(harness.view.disposeCalls).toBe(1);
    expect(harness.subscriptionDisposals).toBe(1);
    expect(harness.inspect.enabled).toBe(false);
  });
});

interface HarnessOptions {
  readonly clipboard?: string;
  readonly clipboardError?: Error;
  readonly commandResponse?: (message: PanelCommand) => Promise<unknown>;
  readonly inspectError?: Error;
}

function createHarness(options: HarnessOptions = {}) {
  const view = new FakePanelView();
  const inspect = new FakeInspectController(options.inspectError);
  const sent: PanelCommand[] = [];
  let clipboardReads = 0;
  let stateListener: ((message: unknown) => void | Promise<void>) | undefined;
  let subscriptionDisposals = 0;
  const controller = new PanelController({
    channel: "channel-1",
    view,
    inspectController: inspect,
    readClipboard: async () => {
      clipboardReads += 1;
      if (options.clipboardError) {
        throw options.clipboardError;
      }
      return options.clipboard ?? "";
    },
    sendCommand: async (message) => {
      sent.push(message);
      return options.commandResponse?.(message) ?? { ok: true };
    },
    subscribeWindowState: (listener) => {
      stateListener = listener;
      return () => {
        subscriptionDisposals += 1;
        if (stateListener === listener) {
          stateListener = undefined;
        }
      };
    },
  });

  return {
    controller,
    inspect,
    sent,
    view,
    get clipboardReads() {
      return clipboardReads;
    },
    get subscriptionDisposals() {
      return subscriptionDisposals;
    },
    async emitState(state: PanelOperationalState): Promise<void> {
      await stateListener?.({
        type: "browser2ide.windowState",
        state: state === "connected" ? "linked" : state,
      });
    },
  };
}

class FakePanelView implements PanelView {
  public actions: PanelActions = missingActions();
  public linkCode = "";
  public current: PanelViewModel = undefined as unknown as PanelViewModel;
  public readonly rendered: PanelViewModel[] = [];
  public disposeCalls = 0;

  public bind(actions: PanelActions): () => void {
    this.actions = actions;
    return () => {
      this.disposeCalls += 1;
    };
  }

  public readLinkCode(): string {
    return this.linkCode;
  }

  public writeLinkCode(value: string): void {
    this.linkCode = value;
  }

  public render(model: PanelViewModel): void {
    this.current = model;
    this.rendered.push(model);
  }

  public editLinkCode(value: string): void {
    this.linkCode = value;
    this.actions.onLinkCodeChanged(value);
  }
}

class FakeInspectController {
  public readonly calls: boolean[] = [];
  public enabled = false;
  public disconnectCalls = 0;

  public constructor(private readonly failure?: Error) {}

  public async setEnabled(enabled: boolean): Promise<void> {
    this.calls.push(enabled);
    if (enabled && this.failure) {
      this.enabled = false;
      throw this.failure;
    }
    this.enabled = enabled;
  }

  public async disable(): Promise<void> {
    if (this.enabled) {
      this.calls.push(false);
    }
    this.enabled = false;
  }

  public handleTransportDisconnect(): void {
    this.disconnectCalls += 1;
    this.enabled = false;
  }
}

function missingActions(): PanelActions {
  const missing = (): never => {
    throw new Error("Panel actions are not bound");
  };
  return {
    onPaste: missing,
    onLink: missing,
    onChangeIde: missing,
    onUnlink: missing,
    onInspectChanged: missing,
    onLinkCodeChanged: missing,
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
