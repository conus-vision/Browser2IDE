import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Firefox DevTools panel assets", () => {
  it("contains the explicit link controls and local bundled scripts", () => {
    const panel = source("panel.html");
    const devtools = source("devtools.html");

    for (const id of [
      "link-code",
      "link-button",
      "unlink-button",
      "inspect-mode",
      "connection-status",
      "selected-summary",
      "link-status",
      "linked-endpoint",
      "linked-session",
      "bridge-instance",
      "last-message",
      "last-error",
      "matched-facts",
      "inaccessible-stylesheets",
    ]) {
      expect(panel).toContain(`id="${id}"`);
    }
    expect(panel).toMatch(
      /<label[^>]*>[\s\S]*Link code[\s\S]*id="link-code"/,
    );
    expect(panel).toMatch(/id="link-code"[^>]*inputmode="numeric"/);
    expect(panel).toMatch(/id="link-code"[^>]*maxlength="9"/);
    expect(panel).toMatch(/id="link-button"[^>]*disabled/);
    expect(panel).toMatch(/id="unlink-button"[^>]*disabled/);
    expect(panel).toContain('type="checkbox"');
    expect(panel).toContain('src="./panel.js"');
    expect(panel).toContain('href="./panel.css"');
    expect(devtools).toContain('src="./devtools.js"');
    expect(panel).not.toMatch(/https?:\/\//);
    expect(devtools).not.toMatch(/https?:\/\//);
    expect(panel).not.toMatch(/auto(?:matic)?[- ]?link|port scan|scanning/i);
  });

  it("removes the legacy connection controls and runtime APIs", () => {
    const panel = source("panel.html");
    const runtime = source("panel.ts");

    for (const removedId of [
      "bridge-url",
      "session-id",
      "pairing-code",
      "pair-button",
      "connect-button",
      "pairing-status",
    ]) {
      expect(panel).not.toContain(`id="${removedId}"`);
    }
    expect(panel).not.toMatch(/\bpair(?:ing)?\b/i);
    for (const removedName of [
      ["reset", "Pairing"].join(""),
      ["pair", "OrReset"].join(""),
      ["pairing", "CodeInput"].join(""),
    ]) {
      expect(runtime).not.toContain(removedName);
    }
    expect(runtime).not.toMatch(/\.pair\(/);
  });
});

function source(name: string): string {
  return readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
}
