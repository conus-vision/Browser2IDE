import {
  parseInspectPortRequest,
  type BackgroundInspectPort,
  type ContentInspectPort,
  type InspectPortInvalidated,
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
  owner: ActiveInspectOwner | undefined;
  releasingOwner: object | undefined;
}

interface ActiveInspectOwner {
  readonly token: object;
  readonly onInvalidated: () => void;
}

export class BackgroundInspectCoordinator {
  private readonly tabs = new Map<number, TabInspectState>();
  private readonly leases = new BackgroundInspectLeaseRegistry();
  private readonly invalidatedOwners = new WeakSet<object>();

  public constructor(private readonly api: BackgroundInspectApi) {}

  public setEnabled(
    owner: object,
    tabId: number,
    enabled: boolean,
    onInvalidated: () => void = () => {},
  ): Promise<void> {
    const state = this.stateFor(tabId);
    if (enabled) {
      this.invalidatedOwners.delete(owner);
      state.owner = { token: owner, onInvalidated };
      state.releasingOwner = undefined;
    } else if (state.owner?.token === owner) {
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
    this.leases.attach(tabId, port, () =>
      this.invalidateContentOwner(tabId),
    );
  }

  public whenIdle(tabId: number): Promise<void> {
    return this.tabs.get(tabId)?.queue ?? Promise.resolve();
  }

  private async enableForCurrentOwner(
    state: TabInspectState,
    owner: object,
    tabId: number,
  ): Promise<void> {
    if (state.owner?.token !== owner) {
      return;
    }
    try {
      await this.api.executeScript({
        target: { tabId },
        files: ["dist/contentScript.js"],
      });
      if (state.owner?.token !== owner) {
        return;
      }
      await this.api.sendTabMessage(tabId, {
        type: "enableInspectMode",
      });
      if (
        state.owner?.token !== owner &&
        this.invalidatedOwners.has(owner)
      ) {
        throw new Error("Inspect content document was disconnected");
      }
    } catch (error) {
      let shouldDisable = false;
      if (state.owner?.token === owner) {
        state.owner = undefined;
        state.releasingOwner = owner;
        this.leases.release(tabId);
        shouldDisable = true;
      } else if (
        state.owner === undefined &&
        this.invalidatedOwners.has(owner)
      ) {
        state.releasingOwner = owner;
        shouldDisable = true;
      }
      const disabled = shouldDisable
        ? await this.tryDisable(tabId)
        : false;
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

  private invalidateContentOwner(tabId: number): void {
    const state = this.tabs.get(tabId);
    const owner = state?.owner;
    if (!state || !owner) {
      return;
    }
    state.owner = undefined;
    state.releasingOwner = undefined;
    this.invalidatedOwners.add(owner.token);
    try {
      owner.onInvalidated();
    } catch {
      // Panel notification cannot restore invalidated inspect ownership.
    }
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
  private readonly pendingRequests = new Set<PendingInspectRequest>();
  private lastOperation = Promise.resolve();
  private disconnected = false;

  public constructor(
    private readonly coordinator: BackgroundInspectCoordinator,
    private readonly tabId: number,
    private readonly sendMessage: (
      message: InspectPortResult | InspectPortInvalidated,
    ) => void,
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
    void this.track(request, true);
  }

  public execute(
    message: unknown,
  ): Promise<BackgroundInspectSessionOutcome | undefined> {
    const request = parseInspectPortRequest(message);
    if (!request || this.disconnected) {
      return Promise.resolve(undefined);
    }
    return this.track(request, false);
  }

  public disconnect(): void {
    this.settlePending("stalePanel", false);
    this.close();
  }

  public retire(error: string): void {
    if (this.disconnected) {
      return;
    }
    this.settlePending(error, true);
    this.close();
  }

  public whenIdle(): Promise<void> {
    return this.lastOperation;
  }

  private track(
    request: InspectPortRequest,
    deliverResult: boolean,
  ): Promise<BackgroundInspectSessionOutcome> {
    let resolveOutcome!: (outcome: BackgroundInspectSessionOutcome) => void;
    const outcome = new Promise<BackgroundInspectSessionOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const pending: PendingInspectRequest = {
      requestId: request.requestId,
      deliverResult,
      resolve: resolveOutcome,
    };
    this.pendingRequests.add(pending);
    const operation = this.coordinator.setEnabled(
      this.owner,
      this.tabId,
      request.enabled,
      () => this.handleInvalidation(),
    );
    this.lastOperation = operation.catch(() => undefined);
    void operation.then(
      () => {
        this.finishRequest(pending, {
          type: "browser2ide.inspect.result",
          requestId: request.requestId,
          ok: true,
        });
      },
      () => {
        this.finishRequest(pending, {
          type: "browser2ide.inspect.result",
          requestId: request.requestId,
          ok: false,
          error: "Inspect mode update failed",
        });
      },
    );
    return outcome;
  }

  private finishRequest(
    pending: PendingInspectRequest,
    result: InspectPortResult,
  ): void {
    if (this.disconnected || !this.pendingRequests.delete(pending)) {
      return;
    }
    if (pending.deliverResult) {
      try {
        this.sendMessage(result);
      } finally {
        pending.resolve({ result, delivered: true });
      }
      return;
    }
    pending.resolve({ result, delivered: false });
  }

  private settlePending(error: string, deliverResult: boolean): void {
    for (const pending of [...this.pendingRequests]) {
      this.pendingRequests.delete(pending);
      const result: InspectPortResult = {
        type: "browser2ide.inspect.result",
        requestId: pending.requestId,
        ok: false,
        error,
      };
      if (deliverResult) {
        try {
          this.sendMessage(result);
        } catch {
          // Retiring ownership must continue if the panel disappears.
        }
      }
      pending.resolve({ result, delivered: deliverResult });
    }
  }

  private close(): void {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    this.lastOperation = this.coordinator
      .release(this.owner, this.tabId)
      .catch(() => undefined);
  }

  private handleInvalidation(): void {
    if (this.disconnected) {
      return;
    }
    this.sendMessage({
      type: "browser2ide.inspect.invalidated",
      reason: "documentDisconnected",
    });
  }
}

export interface BackgroundInspectSessionOutcome {
  readonly result: InspectPortResult;
  readonly delivered: boolean;
}

interface PendingInspectRequest {
  readonly requestId: string;
  readonly deliverResult: boolean;
  readonly resolve: (outcome: BackgroundInspectSessionOutcome) => void;
}

export function attachBackgroundInspectSession(
  port: BackgroundInspectPort,
  coordinator: BackgroundInspectCoordinator,
  trustedTabId: number,
): BackgroundInspectSession {
  const safePost = (
    result: InspectPortResult | InspectPortInvalidated,
  ): void => {
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
