import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  normalizeBrowserPackageTimestamps,
  writeBrowserBundleNotices,
  writeBrowserProjectLicense,
} from "../../tools/browser-bundle-notices.mjs";

const extensionRoot = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(extensionRoot, "dist");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
const result = await build({
  absWorkingDir: extensionRoot,
  entryPoints: {
    devtools: "src/devtools.ts",
    panel: "src/panel.ts",
    background: "src/background.ts",
    contentScript: "src/contentScript.ts",
  },
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome116",
  outdir,
  minify: true,
  sourcemap: false,
  metafile: true,
});

await copyFile(resolve(extensionRoot, "src/devtools.html"), resolve(outdir, "devtools.html"));

for (const asset of ["panel.html", "panel.css", "browser2ide.svg"]) {
  await copyFile(
    resolve(extensionRoot, `../../packages/browser-extension-core/assets/${asset}`),
    resolve(outdir, asset),
  );
}

await writeBrowserProjectLicense(extensionRoot);
await writeBrowserBundleNotices(result.metafile, extensionRoot);
await normalizeBrowserPackageTimestamps(extensionRoot);
