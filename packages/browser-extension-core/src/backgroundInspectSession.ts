import {
  parseInspectPortRequest,
  type BackgroundInspectPort,
  type ContentInspectPort,
  type InspectPortRequest,
  type InspectPortResult,
} from "./inspectPortProtocol.js";
import { BackgroundInspectLeaseRegistry } from "./inspectLease.js";

export interface BackgroundInspectApi {
  executeScript(details: {
    target: { tabId: number };
    files: string[];
  }): Promise<unknown>;
  sendTabMessage(tabId: number, message: unknown): Promise<unknown>;
}

interface TabInspectState {
  queue: Promise<void>;
  owner: object | undefined;
  releasingOwner: object | undefined;
}

export class BackgroundInspectCoordinator {
  private readonly tabs = new Map<number, TabInspectState>();
  private readonly leases = new BackgroundInspectLeaseRegistry();

  public constructor(private readonly api: BackgroundInspectApi) {}

  public setEnabled(
    owner: object,
    tabId: number,
    enabled: boolean,
  ): Promise<void> {
    const state = this.stateFor(tabId);
    if (enabled) {
      state.owner = owner;
      state.releasingOwner = undefined;
    } else if (state.owner === owner) {
      state.owner = undefined;
      state.releasingOwner = owner;
      this.leases.release(tabId);
    } else if (
      state.owner === undefined &&
      state.releasingOwner === owner
    ) {
      // Retry a disable that the same owner could not confirm.
    } else {
      return Promise.resolve();
    }

    return this.enqueue(state, async () => {
      if (enabled) {
        await this.enableForCurrentOwner(state, owner, tabId);
        return;
      }
      await this.disableForReleasingOwner(state, owner, tabId);
    });
  }

  public release(owner: object, tabId: number): Promise<void> {
    return this.setEnabled(owner, tabId, false);
  }

  public attachContentLease(tabId: number, port: ContentInspectPort): void {
    const state = this.tabs.get(tabId);
    if (state?.owner === undefined) {
      try {
        port.disconnect();
      } catch {
        // The content script may have disappeared before registration.
      }
      return;
    }
    this.leases.attach(tabId, port);
  }

  public whenIdle(tabId: number): Promise<void> {
    return this.tabs.get(tabId)?.queue ?? Promise.resolve();
  }

  private async enableForCurrentOwner(
    state: TabInspectState,
    owner: object,
    tabId: number,
  ): Promise<void> {
    if (state.owner !== owner) {
      return;
    }
    try {
      await this.api.executeScript({
        target: { tabId },
        files: ["dist/contentScript.js"],
      });
      if (state.owner !== owner) {
        return;
      }
      await this.api.sendTabMessage(tabId, {
        type: "enableInspectMode",
      });
    } catch (error) {
      if (state.owner === owner) {
        state.owner = undefined;
        state.releasingOwner = owner;
        this.leases.release(tabId);
      }
      const disabled = await this.tryDisable(tabId);
      if (
        disabled &&
        state.owner === undefined &&
        state.releasingOwner === owner
      ) {
        state.releasingOwner = undefined;
      }
      throw error;
    }
  }

  private async disableForReleasingOwner(
    state: TabInspectState,
    owner: object,
    tabId: number,
  ): Promise<void> {
    if (state.owner !== undefined || state.releasingOwner !== owner) {
      return;
    }
    await this.api.sendTabMessage(tabId, {
      type: "disableInspectMode",
    });
    if (state.owner === undefined && state.releasingOwner === owner) {
      state.releasingOwner = undefined;
    }
  }

  private stateFor(tabId: number): TabInspectState {
    const existing = this.tabs.get(tabId);
    if (existing) {
      return existing;
    }
    const created: TabInspectState = {
      queue: Promise.resolve(),
      owner: undefined,
      releasingOwner: undefined,
    };
    this.tabs.set(tabId, created);
    return created;
  }

  private enqueue(
    state: TabInspectState,
    operation: () => Promise<void>,
  ): Promise<void> {
    const result = state.queue.then(operation);
    state.queue = result.catch(() => undefined);
    return result;
  }

  private async tryDisable(tabId: number): Promise<boolean> {
    try {
      await this.api.sendTabMessage(tabId, {
        type: "disableInspectMode",
      });
      return true;
    } catch {
      return false;
    }
  }
}

export class BackgroundInspectSession {
  private readonly owner = {};
  private lastOperation = Promise.resolve();
  private disconnected = false;

  public constructor(
    private readonly coordinator: BackgroundInspectCoordinator,
    private readonly tabId: number,
    private readonly sendResult: (result: InspectPortResult) => void,
  ) {
    if (!Number.isSafeInteger(tabId) || tabId < 0) {
      throw new Error("Invalid trusted inspect tab");
    }
  }

  public handleMessage(message: unknown): void {
    const request = parseInspectPortRequest(message);
    if (!request || this.disconnected) {
      return;
    }
    this.track(request);
  }

  public disconnect(): void {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    this.lastOperation = this.coordinator
      .release(this.owner, this.tabId)
      .catch(() => undefined);
  }

  public whenIdle(): Promise<void> {
    return this.lastOperation;
  }

  private track(request: InspectPortRequest): void {
    const operation = this.coordinator.setEnabled(
      this.owner,
      this.tabId,
      request.enabled,
    );
    this.lastOperation = operation.catch(() => undefined);
    void operation.then(
      () => {
        if (!this.disconnected) {
          this.sendResult({
            type: "browser2ide.inspect.result",
            requestId: request.requestId,
            ok: true,
          });
        }
      },
      () => {
        if (!this.disconnected) {
          this.sendFailure(request.requestId);
        }
      },
    );
  }

  private sendFailure(requestId: string): void {
    this.sendResult({
      type: "browser2ide.inspect.result",
      requestId,
      ok: false,
      error: "Inspect mode update failed",
    });
  }
}

export function attachBackgroundInspectSession(
  port: BackgroundInspectPort,
  coordinator: BackgroundInspectCoordinator,
  trustedTabId: number,
): BackgroundInspectSession {
  const safePost = (result: InspectPortResult): void => {
    try {
      port.postMessage(result);
    } catch {
      // The panel can disappear between completion and acknowledgement.
    }
  };
  const session = new BackgroundInspectSession(
    coordinator,
    trustedTabId,
    safePost,
  );
  const onMessage = (message: unknown): void => {
    session.handleMessage(message);
  };
  const onDisconnect = (): void => {
    port.onMessage.removeListener(onMessage);
    port.onDisconnect.removeListener(onDisconnect);
    session.disconnect();
  };
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);
  return session;
}
