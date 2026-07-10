import * as vscode from "vscode";
import {
  SOURCE_PLUGIN_API_VERSION,
  type Browser2IDEApi,
  type SourcePlugin,
} from "@browser2ide/plugin-api";

const plugin: SourcePlugin = {
  id: "browser2ide.fixture",
  displayName: "Browser2IDE Fixture",
  apiVersion: SOURCE_PLUGIN_API_VERSION,
  documentSelectors: [
    { languageId: "browser2ide-fixture", scheme: "file" },
  ],
  supportedFactKinds: ["fixture.source"],
  async resolve(context) {
    const end = context.document.positionAt(context.document.getText().length);
    return {
      matches: [
        {
          targetRole: "selected",
          range: { start: { line: 0, character: 0 }, end },
          label: "Fixture source",
          kind: "fixture",
          relation: "defines",
          confidence: "instrumented",
        },
      ],
    };
  },
};

export async function activate(context: vscode.ExtensionContext): Promise<{
  readonly registered: boolean;
  readonly coreApiVersion: number;
}> {
  const core = vscode.extensions.getExtension<Browser2IDEApi>(
    "browser2ide.browser2ide-vscode",
  );
  if (!core) throw new Error("Browser2IDE core extension is unavailable");

  const api = await core.activate();
  if (api.apiVersion !== SOURCE_PLUGIN_API_VERSION) {
    throw new Error(`Unsupported Browser2IDE API version: ${api.apiVersion}`);
  }
  context.subscriptions.push(api.registerSourcePlugin(plugin));
  return { registered: true, coreApiVersion: api.apiVersion };
}
