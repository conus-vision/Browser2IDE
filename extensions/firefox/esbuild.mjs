import { copyFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";

const outdir = "dist";

await mkdir(outdir, { recursive: true });
await build({
  entryPoints: {
    devtools: "src/devtools.ts",
    panel: "src/panel.ts",
    background: "src/background.ts",
    contentScript: "src/contentScript.ts",
  },
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "firefox142",
  outdir,
  sourcemap: true,
});

for (const asset of [
  "devtools.html",
  "panel.html",
  "panel.css",
  "browser2ide.svg",
]) {
  await copyFile(`src/${asset}`, `${outdir}/${asset}`);
}
