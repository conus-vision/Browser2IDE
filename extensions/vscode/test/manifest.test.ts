import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("VS Code extension manifest", () => {
  it("declares the Browser2IDE commands and settings", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      contributes: {
        commands: Array<{ command: string }>;
        configuration: { properties: Record<string, { default: unknown }> };
      };
    };

    expect(manifest.contributes.commands.map(({ command }) => command)).toEqual([
      "browser2ide.start",
      "browser2ide.stop",
      "browser2ide.showPairingCode",
      "browser2ide.resetPairing",
      "browser2ide.openDiagnostics",
    ]);
    expect(manifest.contributes.configuration.properties).toMatchObject({
      "browser2ide.bridgeUrl": { default: "ws://127.0.0.1:48735" },
      "browser2ide.bridgePort": { default: 48_735 },
      "browser2ide.sessionId": { default: "default" },
      "browser2ide.openAllReferences": { default: true },
    });
  });
});
