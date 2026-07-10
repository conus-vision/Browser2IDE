import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Firefox extension manifest", () => {
  it("declares a Firefox-first MV3 DevTools adapter with loopback-only defaults", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
    ) as Record<string, any>;

    expect(manifest).toMatchObject({
      manifest_version: 3,
      name: "Browser2IDE",
      devtools_page: "dist/devtools.html",
      background: { scripts: ["dist/background.js"] },
      browser_specific_settings: {
        gecko: {
          id: "browser2ide@local",
          strict_min_version: "142.0",
          data_collection_permissions: {
            required: ["websiteContent", "websiteActivity"],
          },
        },
      },
    });
    expect(manifest.background.service_worker).toBeUndefined();
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(["activeTab", "scripting", "storage"]),
    );
    expect(manifest.permissions).not.toEqual(
      expect.arrayContaining(["nativeMessaging", "debugger"]),
    );
    expect(manifest.host_permissions).toEqual(
      expect.arrayContaining([
        "http://localhost/*",
        "http://127.0.0.1/*",
        "ws://localhost/*",
        "ws://127.0.0.1/*",
      ]),
    );
    expect(manifest.optional_host_permissions).toEqual(["<all_urls>"]);

    const csp = manifest.content_security_policy.extension_pages as string;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self' ws://127.0.0.1:* ws://localhost:*");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });
});
