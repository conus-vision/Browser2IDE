import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Firefox DevTools panel assets", () => {
  it("contains every MVP control and local bundled scripts", () => {
    const panel = readFileSync(
      new URL("../src/panel.html", import.meta.url),
      "utf8",
    );
    const devtools = readFileSync(
      new URL("../src/devtools.html", import.meta.url),
      "utf8",
    );

    for (const id of [
      "bridge-url",
      "pairing-code",
      "session-id",
      "pair-button",
      "connect-button",
      "inspect-mode",
      "connection-status",
      "selected-summary",
    ]) {
      expect(panel).toContain(`id="${id}"`);
    }
    expect(panel).toContain('type="checkbox"');
    expect(panel).toMatch(/id="pair-button"[^>]*disabled/);
    expect(panel).toMatch(/id="connect-button"[^>]*disabled/);
    expect(panel).toContain('src="./panel.js"');
    expect(panel).toContain('href="./panel.css"');
    expect(devtools).toContain('src="./devtools.js"');
    expect(panel).not.toMatch(/https?:\/\//);
    expect(devtools).not.toMatch(/https?:\/\//);
  });
});
