import {
  SOURCE_PLUGIN_API_VERSION,
  type PluginDiagnostic,
  type SourceMatch,
  type SourcePlugin,
  type SourcePluginContext,
  type SourcePluginResult,
} from "@browser2ide/plugin-api";
import { targetCssFacts } from "./cssFacts.js";
import {
  findMatchingCssRules,
  StylesheetAstCache,
} from "./stylesheetAst.js";

export class CssSourcePlugin implements SourcePlugin {
  public readonly id = "browser2ide.css";
  public readonly displayName = "Browser2IDE CSS";
  public readonly apiVersion = SOURCE_PLUGIN_API_VERSION;
  public readonly documentSelectors = [
    { languageId: "css", scheme: "file" },
  ] as const;
  public readonly supportedFactKinds = ["css-rule"] as const;

  public constructor(private readonly ast = new StylesheetAstCache()) {}

  public async resolve(
    context: SourcePluginContext,
  ): Promise<SourcePluginResult> {
    let parsed;
    try {
      parsed = this.ast.parseDocument(context.document, "css");
    } catch (error) {
      return {
        matches: [],
        diagnostics: [parseDiagnostic(error)],
      };
    }

    const matches: SourceMatch[] = [];
    const diagnostics: PluginDiagnostic[] = [];
    const ambiguousUrls = new Set<string>();
    for (const entry of targetCssFacts(context.selection)) {
      if (context.signal.aborted) break;
      const resolution = await context.workspace.resolveSourceUri(
        entry.sourceUrl,
        context.selection.context.url,
      );
      if (
        resolution.status === "ambiguous" &&
        !ambiguousUrls.has(entry.sourceUrl)
      ) {
        ambiguousUrls.add(entry.sourceUrl);
        diagnostics.push(ambiguousSourceDiagnostic(entry.sourceUrl));
      }
      if (!resolution.uris.includes(context.document.uri)) continue;

      for (const rule of findMatchingCssRules(
        parsed,
        entry.fact,
        context.document,
      )) {
        matches.push({
          targetRole: entry.targetRole,
          range: rule.range,
          label: entry.fact.selector,
          kind: "style-rule",
          relation: "styles",
          confidence: entry.fact.source ? "exact" : "heuristic",
          metadata: { sourceUrl: entry.sourceUrl },
        });
      }
    }
    return { matches, diagnostics };
  }
}

function parseDiagnostic(error: unknown): PluginDiagnostic {
  return {
    code: "css.parseFailed",
    message: `CSS could not be parsed: ${messageOf(error)}`,
    severity: "error",
  };
}

function ambiguousSourceDiagnostic(sourceUrl: string): PluginDiagnostic {
  return {
    code: "css.sourceAmbiguous",
    message: `CSS source maps to more than one workspace file: ${sourceUrl}`,
    severity: "warning",
    metadata: { sourceUrl },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
