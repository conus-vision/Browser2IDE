import { describe, expect, it, vi } from "vitest";
import {
  SOURCE_PLUGIN_API_VERSION,
  type PluginDiagnostic,
  type SelectionSnapshot,
  type SourceConfidence,
  type SourceDocument,
  type SourceMatch,
  type SourcePlugin,
  type SourceRange,
  type SourceWorkspace,
} from "@browser2ide/plugin-api";
import { SourcePluginRegistry } from "../src/sourcePlugins/registry.js";

describe("SourcePluginRegistry", () => {
  it("dispatches only plugins matching the active document and fact kinds", async () => {
    const registry = new SourcePluginRegistry();
    registry.register(
      plugin({
        id: "css",
        languageId: "css",
        factKinds: ["css-rule"],
        matches: [match("selected", range(0, 0, 0, 8), "exact")],
      }),
    );
    registry.register(
      plugin({
        id: "scss",
        languageId: "scss",
        factKinds: ["css-rule"],
        matches: [],
      }),
    );
    registry.register(
      plugin({
        id: "html",
        languageId: "css",
        factKinds: ["dom-attribute"],
        matches: [],
      }),
    );

    const result = await registry.resolve(
      selectionWithFacts("css-rule"),
      document("file:///app.css", "css", ".card {}"),
      workspace(),
      new AbortController().signal,
    );

    expect(result.matches.map((candidate) => candidate.pluginId)).toEqual([
      "css",
    ]);
  });

  it("prefers selected and better confidence on the same range", async () => {
    const registry = registryWithMatches([
      match("parent", range(0, 0, 0, 8), "heuristic"),
      match("selected", range(0, 0, 0, 8), "exact"),
    ]);

    const result = await resolveCss(registry);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      targetRole: "selected",
      confidence: "exact",
    });
  });

  it("turns exceptions, invalid ranges, and timeout into diagnostics", async () => {
    const registry = new SourcePluginRegistry({ timeoutMs: 10 });
    registry.register(throwingPlugin("broken"));
    registry.register(outOfBoundsPlugin("invalid"));
    registry.register(neverSettlingPlugin("slow"));

    const result = await resolveCss(registry);

    expect(result.matches).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code).sort()).toEqual([
      "plugin.exception",
      "plugin.invalidRange",
      "plugin.timeout",
    ]);
  });

  it("rejects incompatible and duplicate registrations and emits changes", () => {
    const registry = new SourcePluginRegistry();
    const listener = vi.fn();
    const listenerRegistration = registry.onDidChange(listener);
    const registration = registry.register(plugin({ id: "css" }));

    expect(() => registry.register(plugin({ id: "css" }))).toThrow(
      /already registered/,
    );
    expect(() =>
      registry.register({
        ...plugin({ id: "future" }),
        apiVersion: 2 as typeof SOURCE_PLUGIN_API_VERSION,
      }),
    ).toThrow(/unsupported API version/);

    registration.dispose();
    listenerRegistration.dispose();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

function registryWithMatches(matches: readonly SourceMatch[]) {
  const registry = new SourcePluginRegistry();
  registry.register(plugin({ matches }));
  return registry;
}

function resolveCss(registry: SourcePluginRegistry) {
  return registry.resolve(
    selectionWithFacts("css-rule"),
    document("file:///app.css", "css", ".card {}"),
    workspace(),
    new AbortController().signal,
  );
}

function plugin(
  options: {
    readonly id?: string;
    readonly languageId?: string;
    readonly factKinds?: readonly string[];
    readonly matches?: readonly SourceMatch[];
    readonly diagnostics?: readonly PluginDiagnostic[];
  } = {},
): SourcePlugin {
  return {
    id: options.id ?? "fixture",
    displayName: options.id ?? "Fixture",
    apiVersion: SOURCE_PLUGIN_API_VERSION,
    documentSelectors: [
      { languageId: options.languageId ?? "css", scheme: "file" },
    ],
    supportedFactKinds: options.factKinds ?? ["css-rule"],
    async resolve() {
      return {
        matches: options.matches ?? [],
        diagnostics: options.diagnostics,
      };
    },
  };
}

function throwingPlugin(id: string): SourcePlugin {
  return {
    ...plugin({ id }),
    async resolve() {
      throw new Error("fixture failure");
    },
  };
}

function outOfBoundsPlugin(id: string): SourcePlugin {
  return plugin({
    id,
    matches: [match("selected", range(0, 0, 99, 1), "exact")],
  });
}

function neverSettlingPlugin(id: string): SourcePlugin {
  return {
    ...plugin({ id }),
    resolve: () => new Promise(() => undefined),
  };
}

function match(
  targetRole: "selected" | "parent",
  sourceRange: SourceRange,
  confidence: SourceConfidence,
): SourceMatch {
  return {
    targetRole,
    range: sourceRange,
    label: ".card",
    kind: "style-rule",
    relation: "styles",
    confidence,
  };
}

function range(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
): SourceRange {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

function selectionWithFacts(kind: "css-rule"): SelectionSnapshot {
  return {
    sessionId: "session-1",
    messageId: "inspect-1",
    targets: [
      {
        role: "selected",
        depth: 0,
        subject: { selector: ".card", metadata: {} },
        facts: [
          {
            type: kind,
            selector: ".card",
            property: "display",
            value: "block",
            metadata: {},
          },
        ],
        metadata: {},
      },
    ],
    context: { url: "http://localhost/", metadata: {} },
    metadata: {},
  };
}

function document(uri: string, languageId: string, text: string): SourceDocument {
  const lines = text.split("\n");
  return {
    uri,
    languageId,
    version: 1,
    getText: () => text,
    positionAt(offset) {
      const clamped = Math.max(0, Math.min(offset, text.length));
      let remaining = clamped;
      for (let line = 0; line < lines.length; line += 1) {
        const length = lines[line]?.length ?? 0;
        if (remaining <= length) return { line, character: remaining };
        remaining -= length + 1;
      }
      return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
    },
    offsetAt(position) {
      const line = Math.max(0, Math.min(position.line, lines.length - 1));
      const before = lines
        .slice(0, line)
        .reduce((total, value) => total + value.length + 1, 0);
      const character = Math.max(
        0,
        Math.min(position.character, lines[line]?.length ?? 0),
      );
      return before + character;
    },
  };
}

function workspace(): SourceWorkspace {
  return {
    findFiles: async () => [],
    readText: async () => "",
    resolveSourceUri: async () => ({ uris: [], status: "not-found" }),
    resolveRelativeUri: (baseUri, reference) =>
      new URL(reference, baseUri).toString(),
    isWorkspaceUri: () => true,
  };
}
