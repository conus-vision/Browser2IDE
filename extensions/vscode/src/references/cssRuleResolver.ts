import type {
  CssRuleFact,
  ProtocolErrorCode,
  SourceLocation,
} from "@browser2ide/protocol";
import type {
  ResolvedReference,
  ResolveInput,
  SourceResolver,
} from "./sourceTypes.js";
import {
  SourceMapResolver,
  type SourceMapResolution,
} from "./sourcemapResolver.js";
import {
  findRuleRangeBySelector,
  findWorkspaceFileByUrl,
  findWorkspaceFilesByBasename,
  readText,
  textOffsetAt,
  type RuleTextRange,
  type WorkspaceFileApi,
} from "./workspaceFiles.js";

export interface CssRuleResolverOptions {
  readonly workspace?: WorkspaceFileApi;
  readonly sourceMaps?: SourceMapResolver;
}

export class CssRuleResolver implements SourceResolver {
  public readonly id = "css-rule";
  public readonly supportedFactKinds = ["css-rule"] as const;

  private readonly workspace?: WorkspaceFileApi;
  private readonly sourceMaps: SourceMapResolver;

  public constructor(options: CssRuleResolverOptions = {}) {
    this.workspace = options.workspace;
    this.sourceMaps = options.sourceMaps ?? new SourceMapResolver(options.workspace);
  }

  public async resolve(input: ResolveInput): Promise<ResolvedReference[]> {
    const cssFacts = input.facts.filter(
      (fact): fact is CssRuleFact => fact.type === "css-rule",
    );
    return Promise.all(
      uniqueRuleFacts(cssFacts).map((fact) =>
        this.resolveFact(fact, input.message.context.url),
      ),
    );
  }

  private async resolveFact(
    fact: CssRuleFact,
    pageUrl: string,
  ): Promise<ResolvedReference> {
    const sourceUrl = factSourceUrl(fact);
    if (!sourceUrl) {
      return unresolvedReference(fact, "browser2ide:unmapped", "unmapped", [
        "CSS rule did not include a source URL",
      ]);
    }

    if (isExternalSource(sourceUrl, pageUrl)) {
      return unresolvedReference(fact, sourceUrl, "external", []);
    }

    const workspaceUri =
      (await findWorkspaceFileByUrl(sourceUrl, this.workspace)) ??
      (await findByBasename(sourceUrl, this.workspace));
    if (!workspaceUri) {
      return unresolvedReference(fact, sourceUrl, "unmapped", [
        `Stylesheet was not found in the workspace: ${sourceUrl}`,
      ], "resolver.fileNotFound");
    }

    let generatedText: string;
    try {
      generatedText = await readText(workspaceUri, this.workspace);
    } catch (error) {
      return {
        ...unresolvedReference(fact, sourceUrl, "error", [
          `Stylesheet could not be read: ${messageOf(error)}`,
        ]),
        workspaceUri,
      };
    }

    const nearOffset = fact.source
      ? textOffsetAt(generatedText, {
          line: fact.source.line - 1,
          character: fact.source.column - 1,
        })
      : undefined;
    const generatedRange = findRuleRangeBySelector(
      generatedText,
      fact.selector,
      nearOffset,
    );
    if (!generatedRange) {
      return {
        ...unresolvedReference(fact, sourceUrl, "unmapped", [
          `Selector was not found in the stylesheet: ${fact.selector}`,
        ]),
        workspaceUri,
      };
    }

    const sourceMapResult = await this.sourceMaps.resolve({
      generatedUri: workspaceUri,
      generatedSourceUrl: sourceUrl,
      generatedText,
      generatedRange,
      selector: fact.selector,
    });
    if (sourceMapResult.resolution) {
      return mappedReference(
        fact,
        sourceUrl,
        sourceMapResult.resolution,
        sourceMapResult.diagnostics,
      );
    }

    return {
      kind: "style-rule",
      relation: "styles",
      label: fact.selector,
      source: locationFromRange(
        workspaceUri.toString(),
        generatedRange,
        { sourceUrl },
      ),
      confidence: "heuristic",
      status: "matched",
      metadata: {
        resolverId: "css-rule",
        ...(sourceMapResult.diagnostics.length > 0
          ? { errorCode: "resolver.sourceMapFailed" }
          : {}),
      },
      workspaceUri,
      diagnostics: sourceMapResult.diagnostics,
    };
  }
}

function mappedReference(
  fact: CssRuleFact,
  generatedSourceUrl: string,
  resolution: SourceMapResolution,
  diagnostics: string[],
): ResolvedReference {
  return {
    kind: "style-rule",
    relation: "styles",
    label: fact.selector,
    source: locationFromRange(
      resolution.workspaceUri.toString(),
      resolution.range,
      {
        generatedSourceUrl,
        originalSource: resolution.originalSource,
        sourceMapUri: resolution.mapUri.toString(),
      },
    ),
    confidence: "sourcemap",
    status: "matched",
    metadata: { resolverId: "css-rule" },
    workspaceUri: resolution.workspaceUri,
    diagnostics,
  };
}

function unresolvedReference(
  fact: CssRuleFact,
  uri: string,
  status: "external" | "unmapped" | "error",
  diagnostics: string[],
  errorCode?: ProtocolErrorCode,
): ResolvedReference {
  return {
    kind: "style-rule",
    relation: "styles",
    label: fact.selector,
    source: fact.source ?? {
      uri,
      line: 1,
      column: 1,
      metadata: { sourceUrl: uri },
    },
    confidence: "unknown",
    status,
    metadata: {
      resolverId: "css-rule",
      ...(errorCode ? { errorCode } : {}),
    },
    diagnostics,
  };
}

function locationFromRange(
  uri: string,
  range: RuleTextRange,
  metadata: Record<string, unknown>,
): SourceLocation {
  return {
    uri,
    line: range.start.line + 1,
    column: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1,
    metadata,
  };
}

function factSourceUrl(fact: CssRuleFact): string | undefined {
  const sourceUrl = fact.metadata.sourceUrl;
  if (typeof sourceUrl === "string" && sourceUrl.length > 0) {
    return sourceUrl;
  }

  const stylesheet = fact.metadata.stylesheet;
  if (typeof stylesheet === "string" && stylesheet.length > 0) {
    return stylesheet;
  }

  return fact.source?.uri;
}

function uniqueRuleFacts(facts: readonly CssRuleFact[]): CssRuleFact[] {
  const unique = new Map<string, CssRuleFact>();
  for (const fact of facts) {
    const ruleIndex = fact.metadata.ruleIndex ?? fact.metadata.rulePath ?? null;
    const identity = JSON.stringify([
      factSourceUrl(fact),
      fact.selector,
      fact.source?.line ?? null,
      fact.source?.column ?? null,
      ruleIndex,
    ]);
    if (!unique.has(identity)) {
      unique.set(identity, fact);
    }
  }
  return [...unique.values()];
}

function isExternalSource(sourceUrl: string, pageUrl: string): boolean {
  let source: URL;
  let page: URL;
  try {
    page = new URL(pageUrl);
    source = new URL(sourceUrl, page);
  } catch {
    return false;
  }

  if (source.protocol === "http:" || source.protocol === "https:") {
    return source.origin !== page.origin;
  }
  return source.protocol !== "file:";
}

async function findByBasename(
  sourceUrl: string,
  workspace?: WorkspaceFileApi,
) {
  const basename = basenameFromUrl(sourceUrl);
  if (!basename) {
    return undefined;
  }
  const matches = await findWorkspaceFilesByBasename(basename, workspace);
  return matches[0];
}

function basenameFromUrl(sourceUrl: string): string | undefined {
  try {
    const pathname = new URL(sourceUrl, "http://browser2ide.local/").pathname;
    const basename = pathname.slice(pathname.lastIndexOf("/") + 1);
    return basename || undefined;
  } catch {
    return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
