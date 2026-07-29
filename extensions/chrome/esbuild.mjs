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
  target: "chrome116",
  outdir,
  sourcemap: true,
});

await copyFile("src/devtools.html", `${outdir}/devtools.html`);

for (const asset of ["panel.html", "panel.css", "browser2ide.svg"]) {
  await copyFile(
    `../../packages/browser-extension-core/assets/${asset}`,
    `${outdir}/${asset}`,
  );
}
