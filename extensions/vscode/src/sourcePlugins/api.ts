import {
  SOURCE_PLUGIN_API_VERSION,
  type Browser2IDEApi,
  type SourcePlugin,
} from "@browser2ide/plugin-api";
import type { SourcePluginRegistry } from "./registry.js";

export function createBrowser2IDEApi(
  registry: SourcePluginRegistry,
): Browser2IDEApi {
  return Object.freeze({
    apiVersion: SOURCE_PLUGIN_API_VERSION,
    registerSourcePlugin: (plugin: SourcePlugin) => registry.register(plugin),
  });
}
