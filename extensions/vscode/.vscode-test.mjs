import { resolve } from "node:path";
import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  label: "sourcePluginApi",
  files: "dist/test/integration/**/*.test.cjs",
  version: "1.124.2",
  workspaceFolder: resolve("../../examples/basic-css"),
  extensionDevelopmentPath: [
    resolve("."),
    resolve("../source-plugin-fixture"),
  ],
  skipExtensionDependencies: true,
  mocha: { ui: "tdd", timeout: 20_000 },
  launchArgs: ["--disable-telemetry", "--disable-extension-update-checks"],
});
