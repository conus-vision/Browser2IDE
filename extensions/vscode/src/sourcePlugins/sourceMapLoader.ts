import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type {
  PluginDiagnostic,
  SourceWorkspace,
} from "@browser2ide/plugin-api";
import type { RawSourceMap } from "source-map";

export type LoadedRawSourceMap = Omit<RawSourceMap, "file"> & {
  readonly file?: string;
};

export interface SourceMapLoadResult {
  readonly mapUri?: string;
  readonly rawMap?: LoadedRawSourceMap;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export class SourceMapLoader {
  private readonly cache = new Map<string, LoadedRawSourceMap>();

  public async load(
    generatedUri: string,
    generatedText: string,
    workspace: SourceWorkspace,
  ): Promise<SourceMapLoadResult> {
    const reference = lastSourceMapReference(generatedText);
    if (!reference) {
      return failed("scss.sourceMapMissing", "SCSS source map was not found");
    }

    let mapUri: string;
    let rawJson: string;
    try {
      if (reference.startsWith("data:")) {
        mapUri = `${generatedUri}#inline-source-map`;
        rawJson = decodeDataUrl(reference);
      } else {
        mapUri = workspace.resolveRelativeUri(generatedUri, reference);
        rawJson = await workspace.readText(mapUri);
      }
    } catch (error) {
      return failed(
        "scss.sourceMapMissing",
        `SCSS source map could not be read: ${messageOf(error)}`,
      );
    }

    const cacheKey = `${mapUri}:${createHash("sha256").update(rawJson).digest("hex")}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return { mapUri, rawMap: cached, diagnostics: [] };

    try {
      const parsed = JSON.parse(rawJson) as unknown;
      if (!isRawSourceMap(parsed)) {
        throw new Error("source map has an invalid shape");
      }
      this.cache.set(cacheKey, parsed);
      return { mapUri, rawMap: parsed, diagnostics: [] };
    } catch (error) {
      return failed(
        "scss.sourceMapInvalid",
        `SCSS source map is invalid: ${messageOf(error)}`,
      );
    }
  }
}

function lastSourceMapReference(generatedText: string): string | undefined {
  const directives = [
    ...generatedText.matchAll(
      /(?:\/\*[#@]\s*|\/\/[#@]\s*)sourceMappingURL=([^\s*]+)[^\n]*?/g,
    ),
  ];
  return directives.at(-1)?.[1];
}

function decodeDataUrl(reference: string): string {
  const separator = reference.indexOf(",");
  if (separator < 0) throw new Error("inline source map has no data payload");
  const metadata = reference.slice(5, separator).toLowerCase();
  const payload = reference.slice(separator + 1);
  return metadata.split(";").includes("base64")
    ? Buffer.from(payload, "base64").toString("utf8")
    : decodeURIComponent(payload);
}

function isRawSourceMap(value: unknown): value is LoadedRawSourceMap {
  if (!isRecord(value)) return false;
  return value.version === 3 &&
    Array.isArray(value.sources) &&
    value.sources.every((source) => typeof source === "string") &&
    Array.isArray(value.names) &&
    value.names.every((name) => typeof name === "string") &&
    typeof value.mappings === "string" &&
    (value.file === undefined || typeof value.file === "string") &&
    (value.sourceRoot === undefined || typeof value.sourceRoot === "string") &&
    (value.sourcesContent === undefined ||
      (Array.isArray(value.sourcesContent) &&
        value.sourcesContent.every(
          (content) => content === null || typeof content === "string",
        )));
}

function failed(code: string, message: string): SourceMapLoadResult {
  return {
    diagnostics: [{ code, message, severity: "warning" }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
