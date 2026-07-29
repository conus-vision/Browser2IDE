import { describe, expect, it } from "vitest";
import { ContentInspectLease } from "../src/inspectLease.js";

describe("content inspect lease", () => {
  it("ignores a delayed disconnect from the lease replaced by re-enable", () => {
    const target = new FakeTarget();
    const ports: FakePort[] = [];
    const lease = new ContentInspectLease(target, () => {
      const port = new FakePort();
      ports.push(port);
      return port;
    });

    lease.enable();
    const deliverStaleDisconnect = ports[0].queueDisconnect();

    lease.enable();
    deliverStaleDisconnect();

    expect(ports).toHaveLength(2);
    expect(target.enabled).toBe(true);
    expect(target.disableCalls).toBe(0);
  });
});

class FakeTarget {
  public enabled = false;
  public disableCalls = 0;

  public enable(): void {
    this.enabled = true;
  }

  public disable(): void {
    this.enabled = false;
    this.disableCalls += 1;
  }
}

class FakePort {
  private readonly disconnectListeners = new Set<() => void>();
  public readonly onDisconnect = {
    addListener: (listener: () => void): void => {
      this.disconnectListeners.add(listener);
    },
    removeListener: (listener: () => void): void => {
      this.disconnectListeners.delete(listener);
    },
  };

  public disconnect(): void {}

  public queueDisconnect(): () => void {
    const queued = [...this.disconnectListeners];
    return () => {
      for (const listener of queued) {
        listener();
      }
    };
  }
}
