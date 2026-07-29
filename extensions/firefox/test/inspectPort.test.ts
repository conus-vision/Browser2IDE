import { describe, expect, it } from "vitest";
import {
  INSPECT_PORT_NAME,
} from "../src/inspectPortProtocol.js";
import { PanelInspectTransport } from "../src/panelInspectTransport.js";

describe("panel inspect transport", () => {
  it("correlates a background acknowledgement to its command", async () => {
    const port = new FakePort();
    const transport = new PanelInspectTransport(port);

    const result = transport.send({
      type: "enableInspectMode",
      tabId: 17,
    });
    expect(port.sent).toEqual([
      {
        type: "browser2ide.inspect.setEnabled",
        requestId: "1",
        tabId: 17,
        enabled: true,
      },
    ]);

    port.emitMessage({
      type: "browser2ide.inspect.result",
      requestId: "1",
      ok: true,
    });

    await expect(result).resolves.toEqual({ ok: true });
  });

  it("rejects pending commands and disconnects synchronously on dispose", async () => {
    const port = new FakePort();
    const transport = new PanelInspectTransport(port);
    const pending = transport.send({
      type: "disableInspectMode",
      tabId: 17,
    });

    transport.dispose();

    expect(port.disconnected).toBe(true);
    await expect(pending).rejects.toThrow("Inspect connection is closed");
  });
});

class FakePort {
  public readonly name = INSPECT_PORT_NAME;
  public readonly sent: unknown[] = [];
  public disconnected = false;
  public readonly onMessage = new FakeEvent<(message: unknown) => void>();
  public readonly onDisconnect = new FakeEvent<() => void>();

  public postMessage(message: unknown): void {
    this.sent.push(message);
  }

  public disconnect(): void {
    this.disconnected = true;
    this.onDisconnect.emit();
  }

  public emitMessage(message: unknown): void {
    this.onMessage.emit(message);
  }
}

class FakeEvent<T extends (...args: never[]) => void> {
  private readonly listeners = new Set<T>();

  public addListener(listener: T): void {
    this.listeners.add(listener);
  }

  public removeListener(listener: T): void {
    this.listeners.delete(listener);
  }

  public emit(...args: Parameters<T>): void {
    for (const listener of this.listeners) {
      listener(...args);
    }
  }
}
