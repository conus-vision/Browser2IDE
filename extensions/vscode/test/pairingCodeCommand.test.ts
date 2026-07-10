import { describe, expect, it } from "vitest";
import {
  showPairingCode,
  type PairingCodeInputOptions,
} from "../src/pairing.js";

describe("pairing code command", () => {
  it("refreshes, copies, and keeps a fresh pairing code visible", async () => {
    const copied: string[] = [];
    const displays: PairingCodeInputOptions[] = [];
    let refreshed = false;

    const shown = await showPairingCode({
      async refreshPairing() {
        refreshed = true;
      },
      getPairing() {
        expect(refreshed).toBe(true);
        return {
          code: "123456",
          expiresAt: new Date("2026-07-10T12:02:00.000Z"),
        };
      },
      writeClipboard(value) {
        copied.push(value);
        return Promise.resolve();
      },
      showInputBox(options) {
        displays.push(options);
        return Promise.resolve(undefined);
      },
      showErrorMessage() {
        return Promise.resolve(undefined);
      },
    });

    expect(shown).toBe(true);
    expect(copied).toEqual(["123456"]);
    expect(displays).toEqual([
      {
        title: "Browser2IDE pairing code",
        prompt:
          "Copied to clipboard. Paste this code into Firefox before 2026-07-10T12:02:00.000Z.",
        value: "123456",
        valueSelection: [0, 6],
        ignoreFocusOut: true,
      },
    ]);
  });

  it("shows an actionable error when the bridge cannot start", async () => {
    const errors: string[] = [];

    const shown = await showPairingCode({
      async refreshPairing() {
        throw new Error("bridge start failed");
      },
      getPairing() {
        return {};
      },
      writeClipboard() {
        return Promise.resolve();
      },
      showInputBox() {
        return Promise.resolve(undefined);
      },
      showErrorMessage(message) {
        errors.push(message);
        return Promise.resolve(undefined);
      },
    });

    expect(shown).toBe(false);
    expect(errors).toEqual([
      "Browser2IDE could not create a pairing code: bridge start failed",
    ]);
  });

  it("reports when no pairing code exists after the refresh", async () => {
    const errors: string[] = [];
    let displayed = false;

    const shown = await showPairingCode({
      async refreshPairing() {},
      getPairing() {
        return {};
      },
      writeClipboard() {
        return Promise.resolve();
      },
      showInputBox() {
        displayed = true;
        return Promise.resolve(undefined);
      },
      showErrorMessage(message) {
        errors.push(message);
        return Promise.resolve(undefined);
      },
    });

    expect(shown).toBe(false);
    expect(displayed).toBe(false);
    expect(errors).toEqual([
      'Browser2IDE could not create a pairing code. Run "Browser2IDE: Open Diagnostics" for details.',
    ]);
  });

  it("still displays the code when clipboard access fails", async () => {
    const displays: PairingCodeInputOptions[] = [];

    const shown = await showPairingCode({
      async refreshPairing() {},
      getPairing() {
        return {
          code: "654321",
          expiresAt: new Date("2026-07-10T12:02:00.000Z"),
        };
      },
      writeClipboard() {
        return Promise.reject(new Error("clipboard unavailable"));
      },
      showInputBox(options) {
        displays.push(options);
        return Promise.resolve(undefined);
      },
      showErrorMessage() {
        return Promise.resolve(undefined);
      },
    });

    expect(shown).toBe(true);
    expect(displays[0]?.value).toBe("654321");
    expect(displays[0]?.prompt).toBe(
      "Automatic copy failed. Paste this code into Firefox before 2026-07-10T12:02:00.000Z.",
    );
  });
});
