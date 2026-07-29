import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Chrome build and shared panel assets", () => {
  it("bundles four IIFE entrypoints for Chrome 116 with source maps", () => {
    const build = readBuildScript();

    expect(build).toMatch(/format:\s*["']iife["']/);
    expect(build).toMatch(/target:\s*(?:\[\s*)?["']chrome116["']/);
    expect(build).toMatch(/sourcemap:\s*true/);
    for (const entry of ["background", "contentScript", "devtools", "panel"]) {
      expect(build).toMatch(
        new RegExp(`${entry}:\\s*["']src/${entry}\\.ts["']`),
      );
    }
  });

  it("copies the common panel assets from browser-extension-core", () => {
    const build = readBuildScript();

    expect(build).toContain("packages/browser-extension-core/assets");
    for (const asset of ["panel.html", "panel.css", "browser2ide.svg"]) {
      expect(build).toContain(asset);
      expect(readSharedAsset(asset).length).toBeGreaterThan(0);
    }
  });
});

function readBuildScript(): string {
  return readFileSync(new URL("../esbuild.mjs", import.meta.url), "utf8");
}

function readSharedAsset(name: string): string {
  return readFileSync(
    new URL(
      `../../../packages/browser-extension-core/assets/${name}`,
      import.meta.url,
    ),
    "utf8",
  );
}
