import {
  SOURCE_PLUGIN_API_VERSION,
  type Disposable,
  type SelectionSnapshot,
  type SourceDocument,
  type SourceMatch,
  type SourcePlugin,
  type SourceWorkspace,
} from "@browser2ide/plugin-api";
import type {
  ResolvedPluginDiagnostic,
  ResolvedSourceMatch,
  SourceResolution,
} from "./types.js";

interface PluginResolution {
  readonly matches: readonly ResolvedSourceMatch[];
  readonly diagnostics: readonly ResolvedPluginDiagnostic[];
}

const CONFIDENCE_PRIORITY: Record<SourceMatch["confidence"], number> = {
  exact: 0,
  sourcemap: 1,
  instrumented: 2,
  heuristic: 3,
  unknown: 4,
};

export class SourcePluginRegistry {
  private readonly plugins = new Map<string, SourcePlugin>();
  private readonly listeners = new Set<() => void>();
  private readonly timeoutMs: number;

  public constructor(options: { readonly timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 2_000;
  }

  public register(plugin: SourcePlugin): Disposable {
    if (plugin.apiVersion !== SOURCE_PLUGIN_API_VERSION) {
      throw new Error(
        `Plugin "${plugin.id}" uses unsupported API version ${plugin.apiVersion}`,
      );
    }
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Source plugin "${plugin.id}" is already registered`);
    }
    this.plugins.set(plugin.id, plugin);
    this.emitChange();
    return {
      dispose: () => {
        if (this.plugins.delete(plugin.id)) this.emitChange();
      },
    };
  }

  public onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public async resolve(
    selection: SelectionSnapshot,
    document: SourceDocument,
    workspace: SourceWorkspace,
    signal: AbortSignal,
  ): Promise<SourceResolution> {
    const factKinds = new Set(
      selection.targets.flatMap((target) =>
        target.facts.map((fact) => fact.type),
      ),
    );
    const plugins = [...this.plugins.values()].filter(
      (plugin) =>
        matchesDocument(plugin, document) &&
        plugin.supportedFactKinds.some((kind) => factKinds.has(kind)),
    );
    const settled = await Promise.all(
      plugins.map((plugin) =>
        this.resolvePlugin(plugin, selection, document, workspace, signal),
      ),
    );
    const validated = validateMatches(
      settled.flatMap((entry) => entry.matches),
      selection,
      document,
    );
    return {
      selectionMessageId: selection.messageId,
      documentUri: document.uri,
      documentVersion: document.version,
      matches: deduplicateMatches(validated.matches),
      diagnostics: [
        ...settled.flatMap((entry) => entry.diagnostics),
        ...validated.diagnostics,
      ],
    };
  }

  private async resolvePlugin(
    plugin: SourcePlugin,
    selection: SelectionSnapshot,
    document: SourceDocument,
    workspace: SourceWorkspace,
    signal: AbortSignal,
  ): Promise<PluginResolution> {
    if (signal.aborted) return emptyResolution();

    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const outcome = await Promise.race([
        Promise.resolve()
          .then(() =>
            plugin.resolve({
              selection,
              document,
              workspace,
              signal: controller.signal,
            }),
          )
          .then(
            (result) => ({ kind: "result" as const, result }),
            (error: unknown) => ({ kind: "exception" as const, error }),
          ),
        new Promise<{ readonly kind: "timeout" }>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve({ kind: "timeout" });
          }, this.timeoutMs);
        }),
        new Promise<{ readonly kind: "cancelled" }>((resolve) => {
          controller.signal.addEventListener(
            "abort",
            () => resolve({ kind: "cancelled" }),
            { once: true },
          );
        }),
      ]);

      if (outcome.kind === "cancelled" && !signal.aborted) {
        return diagnosticResolution(plugin.id, {
          code: "plugin.timeout",
          message: `Source plugin "${plugin.displayName}" timed out`,
          severity: "warning",
        });
      }
      if (outcome.kind === "cancelled" || signal.aborted) {
        return emptyResolution();
      }
      if (outcome.kind === "timeout") {
        return diagnosticResolution(plugin.id, {
          code: "plugin.timeout",
          message: `Source plugin "${plugin.displayName}" timed out`,
          severity: "warning",
        });
      }
      if (outcome.kind === "exception") {
        return diagnosticResolution(plugin.id, {
          code: "plugin.exception",
          message: messageOf(outcome.error),
          severity: "error",
        });
      }

      return {
        matches: outcome.result.matches.map((match) => ({
          ...match,
          pluginId: plugin.id,
        })),
        diagnostics: (outcome.result.diagnostics ?? []).map((diagnostic) => ({
          ...diagnostic,
          pluginId: plugin.id,
        })),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  private emitChange(): void {
    for (const listener of this.listeners) listener();
  }
}

function matchesDocument(plugin: SourcePlugin, document: SourceDocument): boolean {
  const scheme = document.uri.slice(0, document.uri.indexOf(":"));
  return plugin.documentSelectors.some(
    (selector) =>
      selector.languageId === document.languageId &&
      (selector.scheme === undefined || selector.scheme === scheme),
  );
}

function validateMatches(
  matches: readonly ResolvedSourceMatch[],
  selection: SelectionSnapshot,
  document: SourceDocument,
): PluginResolution {
  const roles = new Set(selection.targets.map((target) => target.role));
  const valid: ResolvedSourceMatch[] = [];
  const diagnostics: ResolvedPluginDiagnostic[] = [];

  for (const match of matches) {
    if (!roles.has(match.targetRole) || !validRange(match.range, document)) {
      diagnostics.push({
        pluginId: match.pluginId,
        code: "plugin.invalidRange",
        message: `Source plugin "${match.pluginId}" returned an invalid source match`,
        severity: "warning",
      });
      continue;
    }
    valid.push(match);
  }

  return { matches: valid, diagnostics };
}

function validRange(
  range: SourceMatch["range"],
  document: SourceDocument,
): boolean {
  const positions = [range.start, range.end];
  if (
    positions.some(
      (position) =>
        !Number.isInteger(position.line) ||
        !Number.isInteger(position.character) ||
        position.line < 0 ||
        position.character < 0,
    )
  ) {
    return false;
  }

  try {
    const start = document.offsetAt(range.start);
    const end = document.offsetAt(range.end);
    return (
      start < end &&
      samePosition(document.positionAt(start), range.start) &&
      samePosition(document.positionAt(end), range.end)
    );
  } catch {
    return false;
  }
}

function samePosition(
  left: { readonly line: number; readonly character: number },
  right: { readonly line: number; readonly character: number },
): boolean {
  return left.line === right.line && left.character === right.character;
}

function deduplicateMatches(
  matches: readonly ResolvedSourceMatch[],
): readonly ResolvedSourceMatch[] {
  const unique = new Map<string, ResolvedSourceMatch>();
  for (const match of matches) {
    const key = [
      match.range.start.line,
      match.range.start.character,
      match.range.end.line,
      match.range.end.character,
      match.kind,
      match.relation,
    ].join(":");
    const existing = unique.get(key);
    if (!existing || compareMatches(match, existing) < 0) {
      unique.set(key, match);
    }
  }
  return [...unique.values()].sort(compareByRange);
}

function compareMatches(
  left: ResolvedSourceMatch,
  right: ResolvedSourceMatch,
): number {
  return (
    CONFIDENCE_PRIORITY[left.confidence] -
      CONFIDENCE_PRIORITY[right.confidence] ||
    rolePriority(left.targetRole) - rolePriority(right.targetRole) ||
    left.pluginId.localeCompare(right.pluginId)
  );
}

function compareByRange(
  left: ResolvedSourceMatch,
  right: ResolvedSourceMatch,
): number {
  return (
    left.range.start.line - right.range.start.line ||
    left.range.start.character - right.range.start.character ||
    left.range.end.line - right.range.end.line ||
    left.range.end.character - right.range.end.character ||
    compareMatches(left, right)
  );
}

function rolePriority(role: SourceMatch["targetRole"]): number {
  return role === "selected" ? 0 : 1;
}

function emptyResolution(): PluginResolution {
  return { matches: [], diagnostics: [] };
}

function diagnosticResolution(
  pluginId: string,
  diagnostic: Omit<ResolvedPluginDiagnostic, "pluginId">,
): PluginResolution {
  return {
    matches: [],
    diagnostics: [{ ...diagnostic, pluginId }],
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
