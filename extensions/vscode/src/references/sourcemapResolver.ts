import { posix } from "node:path";
import type * as vscode from "vscode";
import { SourceMapConsumer } from "source-map";
import {
  findRuleRangeBySelector,
  findWorkspaceFileByUrl,
  findWorkspaceFilesByBasename,
  readText,
  textOffsetAt,
  type RuleTextRange,
  type WorkspaceFileApi,
} from "./workspaceFiles.js";

export interface SourceMapResolveInput {
  readonly generatedUri: vscode.Uri;
  readonly generatedSourceUrl: string;
  readonly generatedText: string;
  readonly generatedRange: RuleTextRange;
  readonly selector: string;
}

export interface SourceMapResolution {
  readonly workspaceUri: vscode.Uri;
  readonly range: RuleTextRange;
  readonly mapUri: vscode.Uri;
  readonly originalSource: string;
}

export interface SourceMapResolutionResult {
  readonly resolution?: SourceMapResolution;
  readonly diagnostics: string[];
}

export class SourceMapResolver {
  public constructor(private readonly workspace?: WorkspaceFileApi) {}

  public async resolve(
    input: SourceMapResolveInput,
  ): Promise<SourceMapResolutionResult> {
    const mapUrl = sourceMapUrl(input.generatedText, input.generatedSourceUrl);
    if (!mapUrl) {
      return { diagnostics: ["Source map was not found"] };
    }

    const mapUri = await this.findMap(mapUrl, input.generatedUri);
    if (!mapUri) {
      return { diagnostics: ["Source map was not found"] };
    }

    let mapText: string;
    try {
      mapText = await readText(mapUri, this.workspace);
    } catch (error) {
      return { diagnostics: [`Source map could not be read: ${messageOf(error)}`] };
    }

    let original:
      | { source: string | null; line: number | null; column: number | null }
      | undefined;
    try {
      original = await SourceMapConsumer.with(mapText, null, (consumer) =>
        consumer.originalPositionFor({
          line: input.generatedRange.start.line + 1,
          column: input.generatedRange.start.character,
        }),
      );
    } catch (error) {
      return { diagnostics: [`Source map is invalid: ${messageOf(error)}`] };
    }

    if (
      !original?.source ||
      original.line === null ||
      original.column === null
    ) {
      return {
        diagnostics: ["Source map has no mapping for the selected rule"],
      };
    }

    const workspaceUri = await this.findOriginalSource(original.source, mapUrl);
    if (!workspaceUri) {
      return {
        diagnostics: [`Source-mapped file was not found: ${original.source}`],
      };
    }

    let originalText: string;
    try {
      originalText = await readText(workspaceUri, this.workspace);
    } catch (error) {
      return {
        diagnostics: [`Source-mapped file could not be read: ${messageOf(error)}`],
      };
    }

    const mappedOffset = textOffsetAt(originalText, {
      line: original.line - 1,
      character: original.column,
    });
    const range = findRuleRangeBySelector(
      originalText,
      input.selector,
      mappedOffset,
    );
    if (!range) {
      return {
        diagnostics: [`Source-mapped selector was not found: ${input.selector}`],
      };
    }

    return {
      resolution: {
        workspaceUri,
        range,
        mapUri,
        originalSource: original.source,
      },
      diagnostics: [],
    };
  }

  private async findMap(
    mapUrl: string,
    generatedUri: vscode.Uri,
  ): Promise<vscode.Uri | undefined> {
    const exact = await findWorkspaceFileByUrl(mapUrl, this.workspace);
    if (exact) {
      return exact;
    }

    const basename = basenameFromUrl(mapUrl);
    if (!basename) {
      return undefined;
    }

    const candidates = await findWorkspaceFilesByBasename(
      basename,
      this.workspace,
    );
    return preferSibling(candidates, generatedUri);
  }

  private async findOriginalSource(
    originalSource: string,
    mapUrl: string,
  ): Promise<vscode.Uri | undefined> {
    const resolvedUrl = resolveUrl(originalSource, mapUrl);
    const exact = await findWorkspaceFileByUrl(resolvedUrl, this.workspace);
    if (exact) {
      return exact;
    }

    const basename = basenameFromUrl(originalSource);
    if (!basename) {
      return undefined;
    }

    const candidates = await findWorkspaceFilesByBasename(
      basename,
      this.workspace,
    );
    return preferPathSuffix(candidates, resolvedUrl);
  }
}

function sourceMapUrl(generatedText: string, generatedSourceUrl: string): string {
  const directives = [
    ...generatedText.matchAll(/(?:\/\*[#@]\s*|\/\/[#@]\s*)sourceMappingURL=([^\s*]+)[^\n]*?/g),
  ];
  const directive = directives.at(-1)?.[1];
  return resolveUrl(directive ?? `${basenameFromUrl(generatedSourceUrl)}.map`, generatedSourceUrl);
}

function resolveUrl(value: string, base: string): string {
  try {
    const baseUrl = new URL(base, "http://browser2ide.local/");
    return new URL(value, baseUrl).pathname;
  } catch {
    return value;
  }
}

function basenameFromUrl(value: string): string | undefined {
  try {
    const pathname = new URL(value, "http://browser2ide.local/").pathname;
    const basename = posix.basename(pathname);
    return basename || undefined;
  } catch {
    return undefined;
  }
}

function preferSibling(
  candidates: readonly vscode.Uri[],
  generatedUri: vscode.Uri,
): vscode.Uri | undefined {
  const generatedDirectory = directoryPath(generatedUri.fsPath);
  return (
    candidates.find(
      (candidate) => directoryPath(candidate.fsPath) === generatedDirectory,
    ) ?? candidates[0]
  );
}

function preferPathSuffix(
  candidates: readonly vscode.Uri[],
  expectedUrl: string,
): vscode.Uri | undefined {
  const suffix = expectedUrl.replace(/^\/+/, "").replace(/\\/g, "/");
  return (
    candidates.find((candidate) =>
      candidate.fsPath.replace(/\\/g, "/").endsWith(`/${suffix}`),
    ) ?? candidates[0]
  );
}

function directoryPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return normalized.slice(0, normalized.lastIndexOf("/"));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
