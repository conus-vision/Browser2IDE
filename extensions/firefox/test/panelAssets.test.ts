import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("shared DevTools panel assets", () => {
  it("provides compact explicit link and inspect controls", () => {
    const panel = sharedAsset("panel.html");

    for (const id of [
      "connection-status",
      "link-controls",
      "link-form",
      "link-code",
      "paste-button",
      "link-button",
      "connected-controls",
      "change-button",
      "unlink-button",
      "inspect-mode",
      "panel-error",
    ]) {
      expect(panel).toContain(`id="${id}"`);
    }
    expect(panel).toMatch(/id="link-code"[^>]*inputmode="numeric"/);
    expect(panel).toMatch(/id="link-code"[^>]*maxlength="9"/);
    expect(panel).toContain('data-lucide="clipboard-paste"');
    expect(panel).toContain('data-lucide="refresh-cw"');
    expect(panel).toContain('data-lucide="unlink"');
    expect(panel).toContain('data-lucide="mouse-pointer-2"');
    expect(iconButton(panel, "paste-button")).toMatch(/aria-label="Paste link code"/);
    expect(iconButton(panel, "paste-button")).toMatch(/title="Paste link code"/);
    expect(iconButton(panel, "unlink-button")).toMatch(/aria-label="Unlink"/);
    expect(iconButton(panel, "unlink-button")).toMatch(/title="Unlink"/);
    expect(panel).not.toMatch(/https?:\/\//);
    expect(panel).not.toMatch(/auto(?:matic)?[- ]?link|port scan|scanning/i);
  });

  it("keeps the 320px panel operational surface stable", () => {
    const css = sharedAsset("panel.css");

    expect(css).toContain("min-width: 240px");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(css).toMatch(/\.icon-button\s*\{[^}]*width:\s*28px[^}]*height:\s*28px/s);
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).not.toMatch(/letter-spacing:\s*-+/);
  });

  it("uses a thin Firefox adapter and shared build assets", () => {
    const runtime = firefoxSource("panel.ts");
    const build = firefoxSource("../esbuild.mjs");
    const controller = sharedSource("panelController.ts");

    expect(runtime).toContain("new PanelController");
    expect(runtime).toContain("new PanelInspectTransport");
    expect(runtime).toContain("createPanelIcons");
    expect(controller).toContain("createIcons");
    expect(runtime).toContain("navigator.clipboard.readText");
    expect(runtime).not.toContain("BrowserBridgeClient");
    expect(runtime).not.toContain("storage.local");
    expect(runtime).not.toContain("PanelLifecycleCoordinator");
    expect(build).toContain("packages/browser-extension-core/assets");
  });
});

function iconButton(panel: string, id: string): string {
  const match = new RegExp(`<button[^>]*id="${id}"[^>]*>`).exec(panel);
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

function sharedAsset(name: string): string {
  return readFileSync(
    new URL(`../../../packages/browser-extension-core/assets/${name}`, import.meta.url),
    "utf8",
  );
}

function sharedSource(name: string): string {
  return readFileSync(
    new URL(`../../../packages/browser-extension-core/src/${name}`, import.meta.url),
    "utf8",
  );
}

function firefoxSource(name: string): string {
  return readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
}
