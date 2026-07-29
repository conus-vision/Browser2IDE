import { describe, expect, it } from "vitest";
import { startExampleServers } from "../../../examples/basic-css/server.mjs";

describe("basic CSS example server", () => {
  it("serves source-mapped, heuristic, unmapped, and external CSS fixtures", async () => {
    const servers = await startExampleServers({
      pagePort: 0,
      vendorPort: 0,
    });

    try {
      const page = await responseText(servers.pageUrl);
      const appCss = await responseText(new URL("dist/app.css", servers.pageUrl));
      const sourceMap = JSON.parse(
        await responseText(new URL("dist/app.css.map", servers.pageUrl)),
      ) as { sources: string[] };
      const fallbackCss = await responseText(
        new URL("fallback.css", servers.pageUrl),
      );
      const virtualCss = await responseText(
        new URL("virtual.css", servers.pageUrl),
      );
      const vendorResponse = await fetch(servers.vendorCssUrl);

      expect(page).toContain(servers.vendorCssUrl);
      expect(page).toContain('href="./dist/app.css"');
      expect(page).toContain('href="./fallback.css"');
      expect(page).toContain('href="./virtual.css"');
      expect(page).toContain('id="normal-click-count"');
      expect(page).toContain('id="fixture-card"');
      expect(appCss).toContain("sourceMappingURL=app.css.map");
      expect(appCss).toContain(".layout > .card");
      expect(sourceMap.sources).toEqual([
        "../src/card.scss",
        "../src/layout.scss",
      ]);
      expect(fallbackCss).toContain(".card");
      expect(virtualCss).toContain(".card");
      expect(vendorResponse.headers.get("access-control-allow-origin")).toBe(
        "*",
      );
      await expect(vendorResponse.text()).resolves.toContain(".card");

      const missing = await fetch(new URL("missing.css", servers.pageUrl));
      expect(missing.status).toBe(404);
    } finally {
      await servers.stop();
    }
  });
});

async function responseText(url: URL | string): Promise<string> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return response.text();
}
