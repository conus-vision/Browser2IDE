import { describe, expect, it } from "vitest";
import type {
  SelectionSnapshot,
  SourceDocument,
  SourceWorkspace,
} from "@browser2ide/plugin-api";
import type { CssRuleFact, InspectTarget } from "@browser2ide/protocol";
import { CssSourcePlugin } from "../src/sourcePlugins/cssSourcePlugin.js";

describe("CssSourcePlugin", () => {
  it("returns every complete selected and parent CSS rule", async () => {
    const text = [
      ".layout { display: grid; }",
      ".card { color: red; }",
      "@media (min-width: 40rem) {",
      "  .card { color: blue; }",
      "}",
    ].join("\n");
    const result = await resolveCss(
      text,
      selection([
        cssTarget("selected", ".card", "/dist/app.css"),
        cssTarget("parent", ".layout", "/dist/app.css"),
      ]),
    );

    expect(result.matches.map((match) => [match.targetRole, match.label])).toEqual(
      [
        ["selected", ".card"],
        ["selected", ".card"],
        ["parent", ".layout"],
      ],
    );
    expect(snippets(text, result.matches)).toEqual([
      ".card { color: red; }",
      ".card { color: blue; }",
      ".layout { display: grid; }",
    ]);
  });

  it("uses exact confidence for a positioned fact and heuristic for selector fallback", async () => {
    const text = ".card { color: red; }\n.card { color: blue; }";
    const exact = await resolveCss(
      text,
      selection([
        cssTarget("selected", ".card", "/dist/app.css", {
          uri: "http://localhost:4173/dist/app.css",
          line: 2,
          column: 1,
          metadata: {},
        }),
      ]),
    );
    const fallback = await resolveCss(
      text,
      selection([cssTarget("selected", ".card", "/dist/app.css")]),
    );

    expect(exact.matches).toHaveLength(1);
    expect(exact.matches[0]?.confidence).toBe("exact");
    expect(snippets(text, exact.matches)).toEqual([
      ".card { color: blue; }",
    ]);
    expect(fallback.matches).toHaveLength(2);
    expect(fallback.matches[0]?.confidence).toBe("heuristic");
  });

  it("uses precise source evidence and a namespaced rule path", async () => {
    const text = ".card,\n.featured { color: red; }\n.other { color: blue; }";
    const positioned = await resolveCss(
      text,
      selection([
        cssTarget("selected", ".card,.featured", "/dist/app.css", {
          uri: "http://localhost:4173/dist/app.css",
          line: 1,
          column: 1,
          metadata: {},
        }),
      ]),
    );
    const pathTarget = cssTarget("selected", ".other", "/dist/app.css");
    pathTarget.facts[0]!.metadata.rulePath = "0.1";
    const byPath = await resolveCss(text, selection([pathTarget]));

    expect(snippets(text, positioned.matches)).toEqual([
      ".card,\n.featured { color: red; }",
    ]);
    expect(snippets(text, byPath.matches)).toEqual([
      ".other { color: blue; }",
    ]);
  });

  it("does not confuse a nested rule path with its root suffix", async () => {
    const text = [
      "@media (min-width: 40rem) {",
      "  .first { color: black; }",
      "  .nested { color: red; }",
      "}",
      ".root { color: blue; }",
    ].join("\n");
    const target = cssTarget("selected", ".nested", "/dist/app.css");
    target.facts[0]!.metadata.rulePath = "0.0.1";

    const result = await resolveCss(text, selection([target]));

    expect(snippets(text, result.matches)).toEqual([
      ".nested { color: red; }",
    ]);
  });

  it("maps CSSOM nesting paths without confusing declarations or sibling parents", async () => {
    const text = [
      ".card {",
      "  color: red;",
      "  /* CSSOM does not count this comment as a rule. */",
      "  > .title { color: blue; }",
      "  background: silver;",
      "}",
      ".panel {",
      "  color: black;",
      "  > .title { color: green; }",
      "  background: white;",
      "}",
    ].join("\n");
    const target = cssTarget("selected", ".card", "/dist/app.css");
    target.facts[0]!.metadata.rulePath = "0.0";
    target.facts.push(
      cssFact("& > .title", "color", "blue", "/dist/app.css", "0.0.0"),
      cssFact(".card", "background", "silver", "/dist/app.css", "0.0.1"),
    );

    const result = await resolveCss(text, selection([target]));

    expect(snippets(text, result.matches)).toEqual([
      [
        ".card {",
        "  color: red;",
        "  /* CSSOM does not count this comment as a rule. */",
        "  > .title { color: blue; }",
        "  background: silver;",
        "}",
      ].join("\n"),
      "> .title { color: blue; }",
      [
        ".card {",
        "  color: red;",
        "  /* CSSOM does not count this comment as a rule. */",
        "  > .title { color: blue; }",
        "  background: silver;",
        "}",
      ].join("\n"),
    ]);
  });

  it("uses CSSOM paths and media evidence for rules nested in a group", async () => {
    const text = [
      ".card {",
      "  @media (min-width: 40rem) {",
      "    .title { color: blue; }",
      "  }",
      "}",
      ".panel {",
      "  @media (min-width: 40rem) {",
      "    .title { color: green; }",
      "  }",
      "}",
    ].join("\n");
    const target = cssTarget("selected", "& .title", "/dist/app.css");
    target.facts[0]!.metadata.rulePath = "0.0.0.0";
    target.facts[0]!.metadata.media = ["(min-width: 40rem)"];

    const result = await resolveCss(text, selection([target]));

    expect(snippets(text, result.matches)).toEqual([
      ".title { color: blue; }",
    ]);
  });

  it("falls back safely when an untrusted rule path is malformed or excessive", async () => {
    const malformed = cssTarget("selected", ".card", "/dist/app.css");
    malformed.facts[0]!.metadata.rulePath = "0.not-an-index";
    const excessive = cssTarget("parent", ".layout", "/dist/app.css");
    excessive.facts[0]!.metadata.rulePath = `0.${"1.".repeat(1000)}1`;

    const result = await resolveCss(
      ".layout { display: grid; }\n.card { color: red; }",
      selection([malformed, excessive]),
    );

    expect(result.matches.map((match) => [match.targetRole, match.label])).toEqual([
      ["selected", ".card"],
      ["parent", ".layout"],
    ]);
  });

  it("does not match an ambiguous or different active CSS source", async () => {
    const ambiguous = await resolveCss(
      ".card {}",
      selection([cssTarget("selected", ".card", "/app.css")]),
      { uris: [], status: "ambiguous" },
    );
    const different = await resolveCss(
      ".card {}",
      selection([cssTarget("selected", ".card", "/app.css")]),
      { uris: ["file:///workspace/other.css"], status: "exact" },
    );

    expect(ambiguous.matches).toEqual([]);
    expect(ambiguous.diagnostics?.[0]?.code).toBe("css.sourceAmbiguous");
    expect(different.matches).toEqual([]);
  });

  it("coalesces declaration facts from the same rule", async () => {
    const target = cssTarget("selected", ".card", "/dist/app.css");
    target.facts.push({
      ...target.facts[0]!,
      property: "padding",
      value: "1rem",
    });

    const result = await resolveCss(".card { color: red; padding: 1rem; }", selection([target]));

    expect(result.matches).toHaveLength(1);
  });

  it("filters media evidence and returns parse diagnostics without stale ranges", async () => {
    const plugin = new CssSourcePlugin();
    const text = [
      ".card { color: red; }",
      "@media (min-width: 40rem) { .card { color: blue; } }",
    ].join("\n");
    const target = cssTarget("selected", ".card", "/dist/app.css");
    (target.facts[0] as CssRuleFact).metadata.media = ["(min-width: 40rem)"];
    const first = await resolveCss(text, selection([target]), undefined, plugin);

    expect(snippets(text, first.matches)).toEqual([
      ".card { color: blue; }",
    ]);

    const malformed = await resolveCss(
      ".card { color: red;",
      selection([cssTarget("selected", ".card", "/dist/app.css")]),
      undefined,
      plugin,
      2,
    );
    expect(malformed.matches).toEqual([]);
    expect(malformed.diagnostics?.map((entry) => entry.code)).toEqual([
      "css.parseFailed",
    ]);
  });
});

type Resolution = Awaited<ReturnType<SourceWorkspace["resolveSourceUri"]>>;

async function resolveCss(
  text: string,
  selected: SelectionSnapshot,
  resolution: Resolution = {
    uris: ["file:///workspace/dist/app.css"],
    status: "exact",
  },
  plugin = new CssSourcePlugin(),
  version = 1,
) {
  const sourceDocument = document(text, version);
  return plugin.resolve({
    selection: selected,
    document: sourceDocument,
    workspace: workspace(resolution),
    signal: new AbortController().signal,
  });
}

function selection(targets: readonly InspectTarget[]): SelectionSnapshot {
  return {
    sessionId: "session-1",
    messageId: "inspect-1",
    targets,
    context: { url: "http://localhost:4173/page", metadata: {} },
    metadata: {},
  };
}

function cssTarget(
  role: "selected" | "parent",
  selector: string,
  sourceUrl: string,
  source?: CssRuleFact["source"],
): InspectTarget & { facts: CssRuleFact[] } {
  return {
    role,
    depth: role === "selected" ? 0 : 1,
    subject: { selector, metadata: {} },
    facts: [
      {
        type: "css-rule",
        selector,
        property: "color",
        value: "red",
        source,
        metadata: { sourceUrl },
      },
    ],
    metadata: {},
  };
}

function cssFact(
  selector: string,
  property: string,
  value: string,
  sourceUrl: string,
  rulePath: string,
): CssRuleFact {
  return {
    type: "css-rule",
    selector,
    property,
    value,
    metadata: { sourceUrl, rulePath },
  };
}

function document(text: string, version: number): SourceDocument {
  const lines = text.split("\n");
  return {
    uri: "file:///workspace/dist/app.css",
    languageId: "css",
    version,
    getText: () => text,
    positionAt(offset) {
      const clamped = Math.max(0, Math.min(offset, text.length));
      const before = text.slice(0, clamped).split("\n");
      return {
        line: before.length - 1,
        character: before.at(-1)?.length ?? 0,
      };
    },
    offsetAt(position) {
      const line = Math.max(0, Math.min(position.line, lines.length - 1));
      const before = lines
        .slice(0, line)
        .reduce((total, value) => total + value.length + 1, 0);
      return before + Math.max(
        0,
        Math.min(position.character, lines[line]?.length ?? 0),
      );
    },
  };
}

function workspace(resolution: Resolution): SourceWorkspace {
  return {
    findFiles: async () => resolution.uris,
    readText: async () => "",
    resolveSourceUri: async () => resolution,
    resolveRelativeUri: (base, reference) => new URL(reference, base).toString(),
    isWorkspaceUri: () => true,
  };
}

function snippets(
  text: string,
  matches: readonly { readonly range: SourceMatchRange }[],
): string[] {
  const sourceDocument = document(text, 1);
  return matches.map((match) =>
    text.slice(
      sourceDocument.offsetAt(match.range.start),
      sourceDocument.offsetAt(match.range.end),
    ),
  );
}

interface SourceMatchRange {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
}
