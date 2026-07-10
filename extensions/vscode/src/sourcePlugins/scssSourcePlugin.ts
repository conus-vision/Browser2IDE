import {
  SOURCE_PLUGIN_API_VERSION,
  type PluginDiagnostic,
  type SourceMatch,
  type SourcePlugin,
  type SourcePluginContext,
  type SourcePluginResult,
} from "@browser2ide/plugin-api";
import {
  SourceMapConsumer,
  type RawSourceMap,
} from "source-map";
import { targetCssFacts, type TargetCssFact } from "./cssFacts.js";
import {
  findMatchingCssRules,
  smallestContainingRule,
  StylesheetAstCache,
  type StylesheetRule,
} from "./stylesheetAst.js";
import {
  SourceMapLoader,
  type LoadedRawSourceMap,
} from "./sourceMapLoader.js";

interface MappedPosition {
  readonly source: string;
  readonly line: number;
  readonly column: number;
}

export class ScssSourcePlugin implements SourcePlugin {
  public readonly id = "browser2ide.scss";
  public readonly displayName = "Browser2IDE SCSS";
  public readonly apiVersion = SOURCE_PLUGIN_API_VERSION;
  public readonly documentSelectors = [
    { languageId: "scss", scheme: "file" },
  ] as const;
  public readonly supportedFactKinds = ["css-rule"] as const;

  public constructor(
    private readonly ast = new StylesheetAstCache(),
    private readonly maps = new SourceMapLoader(),
  ) {}

  public async resolve(
    context: SourcePluginContext,
  ): Promise<SourcePluginResult> {
    let original;
    try {
      original = this.ast.parseDocument(context.document, "scss");
    } catch (error) {
      return {
        matches: [],
        diagnostics: [diagnostic(
          "scss.parseFailed",
          `SCSS could not be parsed: ${messageOf(error)}`,
          "error",
        )],
      };
    }

    const matches: SourceMatch[] = [];
    const diagnostics: PluginDiagnostic[] = [];
    for (const entry of targetCssFacts(context.selection)) {
      if (context.signal.aborted) break;
      const generatedResolution = await context.workspace.resolveSourceUri(
        entry.sourceUrl,
        context.selection.context.url,
      );
      if (generatedResolution.status === "ambiguous") {
        diagnostics.push(diagnostic(
          "scss.generatedSourceAmbiguous",
          `Generated CSS maps to more than one workspace file: ${entry.sourceUrl}`,
        ));
      }
      for (const generatedUri of generatedResolution.uris) {
        await this.resolveGenerated(
          context,
          entry,
          generatedUri,
          original.rules,
          matches,
          diagnostics,
        );
      }
    }

    return {
      matches: deduplicate(matches).sort(compareByRange),
      diagnostics: deduplicateDiagnostics(diagnostics),
    };
  }

  private async resolveGenerated(
    context: SourcePluginContext,
    entry: TargetCssFact,
    generatedUri: string,
    originalRules: readonly StylesheetRule[],
    matches: SourceMatch[],
    diagnostics: PluginDiagnostic[],
  ): Promise<void> {
    let generatedText: string;
    let generated;
    try {
      generatedText = await context.workspace.readText(generatedUri);
      generated = this.ast.parseText(generatedUri, "css", generatedText);
    } catch (error) {
      diagnostics.push(diagnostic(
        "scss.generatedReadFailed",
        `Generated CSS could not be read or parsed: ${messageOf(error)}`,
        "error",
      ));
      return;
    }

    const mapResult = await this.maps.load(
      generatedUri,
      generatedText,
      context.workspace,
    );
    if (!mapResult.rawMap || !mapResult.mapUri) {
      diagnostics.push(...mapResult.diagnostics);
      return;
    }

    const generatedRules = findMatchingCssRules(
      generated.rules,
      entry.fact,
      generated.document,
    );
    let mapped: readonly (MappedPosition | undefined)[];
    try {
      mapped = await mapGeneratedStarts(mapResult.rawMap, generatedRules);
    } catch (error) {
      diagnostics.push(diagnostic(
        "scss.sourceMapInvalid",
        `SCSS source map is invalid: ${messageOf(error)}`,
      ));
      return;
    }

    for (const [index, generatedRule] of generatedRules.entries()) {
      const position = mapped[index];
      if (!position) {
        diagnostics.push(mappingMissingDiagnostic(entry.fact.selector));
        continue;
      }
      const sourceResolution = await context.workspace.resolveSourceUri(
        position.source,
        mapResult.mapUri,
      );
      if (sourceResolution.status === "ambiguous") {
        diagnostics.push(diagnostic(
          "scss.sourceAmbiguous",
          `Mapped SCSS source is ambiguous: ${position.source}`,
        ));
        continue;
      }
      if (!sourceResolution.uris.includes(context.document.uri)) continue;

      const rule = smallestContainingRule(
        originalRules,
        context.document.offsetAt({
          line: position.line - 1,
          character: position.column,
        }),
      );
      if (!rule) {
        diagnostics.push(mappingMissingDiagnostic(entry.fact.selector));
        continue;
      }
      matches.push(sourceMappedMatch(
        entry,
        rule,
        generatedUri,
        mapResult.mapUri,
      ));
    }
  }
}

async function mapGeneratedStarts(
  rawMap: LoadedRawSourceMap,
  rules: readonly StylesheetRule[],
): Promise<readonly (MappedPosition | undefined)[]> {
  return SourceMapConsumer.with(rawMap as RawSourceMap, null, (consumer) =>
    rules.map((rule) => {
      const mapped = consumer.originalPositionFor({
        line: rule.range.start.line + 1,
        column: rule.range.start.character,
      });
      if (!mapped.source || mapped.line === null || mapped.column === null) {
        return undefined;
      }
      return {
        source: mapped.source,
        line: mapped.line,
        column: mapped.column,
      };
    }),
  );
}

function sourceMappedMatch(
  entry: TargetCssFact,
  rule: StylesheetRule,
  generatedUri: string,
  mapUri: string,
): SourceMatch {
  return {
    targetRole: entry.targetRole,
    range: rule.range,
    label: entry.fact.selector,
    kind: "style-rule",
    relation: "styles",
    confidence: "sourcemap",
    metadata: { generatedUri, mapUri, sourceUrl: entry.sourceUrl },
  };
}

function mappingMissingDiagnostic(selector: string): PluginDiagnostic {
  return diagnostic(
    "scss.mappingMissing",
    `Source map has no SCSS rule mapping for ${selector}`,
  );
}

function diagnostic(
  code: string,
  message: string,
  severity: PluginDiagnostic["severity"] = "warning",
): PluginDiagnostic {
  return { code, message, severity };
}

function deduplicate(matches: readonly SourceMatch[]): SourceMatch[] {
  const unique = new Map<string, SourceMatch>();
  for (const match of matches) {
    const key = JSON.stringify([
      match.targetRole,
      match.range,
      match.kind,
      match.relation,
    ]);
    if (!unique.has(key)) unique.set(key, match);
  }
  return [...unique.values()];
}

function deduplicateDiagnostics(
  diagnostics: readonly PluginDiagnostic[],
): PluginDiagnostic[] {
  const unique = new Map<string, PluginDiagnostic>();
  for (const entry of diagnostics) {
    const key = `${entry.code}:${entry.message}`;
    if (!unique.has(key)) unique.set(key, entry);
  }
  return [...unique.values()];
}

function compareByRange(left: SourceMatch, right: SourceMatch): number {
  return left.range.start.line - right.range.start.line ||
    left.range.start.character - right.range.start.character ||
    left.range.end.line - right.range.end.line ||
    left.range.end.character - right.range.end.character;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
