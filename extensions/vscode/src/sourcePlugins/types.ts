import type {
  PluginDiagnostic,
  SourceMatch,
} from "@browser2ide/plugin-api";

export interface ResolvedSourceMatch extends SourceMatch {
  readonly pluginId: string;
}

export interface ResolvedPluginDiagnostic extends PluginDiagnostic {
  readonly pluginId: string;
}

export interface SourceResolution {
  readonly selectionMessageId: string;
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly matches: readonly ResolvedSourceMatch[];
  readonly diagnostics: readonly ResolvedPluginDiagnostic[];
}
