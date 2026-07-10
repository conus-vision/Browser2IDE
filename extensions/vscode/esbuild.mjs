import { build } from "esbuild";

await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode", "source-map"],
  outfile: "dist/extension.cjs",
  sourcemap: true,
});
