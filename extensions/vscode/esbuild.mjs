import { build } from "esbuild";

await Promise.all([
  build({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["vscode", "source-map"],
    outfile: "dist/extension.cjs",
    sourcemap: true,
  }),
  build({
    entryPoints: ["test/integration/sourcePluginApi.test.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["vscode"],
    outfile: "dist/test/integration/sourcePluginApi.test.cjs",
    sourcemap: true,
  }),
]);
