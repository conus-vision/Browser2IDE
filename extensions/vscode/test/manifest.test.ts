import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("VS Code extension manifest", () => {
  it("declares the Browser2IDE commands and settings", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      type: string;
      main: string;
      contributes: {
        commands: Array<{ command: string }>;
        configuration: { properties: Record<string, { default: unknown }> };
        viewsContainers: {
          activitybar: Array<{ id: string; title: string; icon: string }>;
        };
        views: Record<string, Array<{ id: string; name: string }>>;
        colors: Array<{
          id: string;
          defaults: { dark: string; light: string; highContrast: string };
        }>;
      };
    };

    expect(manifest.type).toBe("module");
    expect(manifest.main).toBe("./dist/extension.cjs");
    expect((manifest as { publisher?: string }).publisher).toBe("browser2ide");

    expect(manifest.contributes.commands.map(({ command }) => command)).toEqual([
      "browser2ide.start",
      "browser2ide.stop",
      "browser2ide.showPairingCode",
      "browser2ide.resetPairing",
      "browser2ide.openDiagnostics",
      "browser2ide.revealSourceMatch",
    ]);
    expect(manifest.contributes.configuration.properties).toMatchObject({
      "browser2ide.bridgeUrl": { default: "ws://127.0.0.1:48735" },
      "browser2ide.bridgePort": { default: 48_735 },
      "browser2ide.sessionId": { default: "default" },
    });
    expect(Object.keys(manifest.contributes.configuration.properties)).toEqual([
      "browser2ide.bridgeUrl",
      "browser2ide.bridgePort",
      "browser2ide.sessionId",
    ]);

    expect(manifest.contributes.viewsContainers.activitybar).toContainEqual({
      id: "browser2ide",
      title: "Browser2IDE",
      icon: "resources/browser2ide.svg",
    });
    expect(manifest.contributes.views.browser2ide).toContainEqual({
      id: "browser2ide.applicableRules",
      name: "Applicable Sources",
    });
    expect(manifest.contributes.colors.map(({ id }) => id)).toEqual([
      "browser2ide.selectedRuleBackground",
      "browser2ide.selectedRuleBorder",
      "browser2ide.parentRuleBackground",
      "browser2ide.parentRuleBorder",
    ]);
    expect(
      existsSync(new URL("../resources/browser2ide.svg", import.meta.url)),
    ).toBe(true);
    expect(
      readFileSync(new URL("../resources/browser2ide.svg", import.meta.url), "utf8"),
    ).toMatch(/<svg[^>]*width="24"[^>]*height="24"/);
  });
});
