import { describe, expect, it } from "vitest";
import type {
  SelectionSnapshot,
  SourceDocument,
  SourceWorkspace,
} from "@browser2ide/plugin-api";
import {
  INSPECT_LIMITS,
  type CssRuleFact,
  type InspectTarget,
} from "@browser2ide/protocol";
import { CssSourcePlugin } from "../src/sourcePlugins/cssSourcePlugin.js";
import {
  findMatchingCssRules,
  normalizeSelector,
  StylesheetAstCache,
} from "../src/sourcePlugins/stylesheetAst.js";

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

  it.each([
    {
      name: "unquoted attribute values",
      first: "[type=button]",
      second: '[type="button"]',
      browser: '[type="button"]',
    },
    {
      name: "escaped identifiers",
      first: ".\\63 ard",
      second: ".card",
      browser: ".card",
    },
    {
      name: "equivalent nth expressions",
      first: ":nth-child(odd)",
      second: ":nth-child(2n+1)",
      browser: ":nth-child(2n+1)",
    },
  ])("uses a trusted path for $name without selector serialization", async ({
    first,
    second,
    browser,
  }) => {
    const text = [
      `${first} { color: red; }`,
      `${second} { color: blue; }`,
    ].join("\n");
    const target = cssTarget("selected", browser, "/dist/app.css");
    target.facts[0]!.metadata.rulePath = "0.0";

    const result = await resolveCss(text, selection([target]));

    expect(snippets(text, result.matches)).toEqual([
      `${first} { color: red; }`,
    ]);
  });

  it("uses a trusted path for minified nested selectors and uppercase media", async () => {
    const text = [
      "@MEDIA (min-width:40rem) {",
      "  .card {",
      "    >.title,.summary { color: red; }",
      "  }",
      "}",
      "@media (min-width: 40rem) {",
      "  .card {",
      "    > .title, .summary { color: blue; }",
      "  }",
      "}",
    ].join("\n");
    const target = cssTarget(
      "selected",
      "& > .title, & .summary",
      "/dist/app.css",
    );
    target.facts[0]!.metadata.rulePath = "0.0.0.0";
    target.facts[0]!.metadata.media = ["(min-width: 40rem)"];

    const result = await resolveCss(text, selection([target]));

    expect(snippets(text, result.matches)).toEqual([
      ">.title,.summary { color: red; }",
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

  it("preserves nested declaration runs through supports and media groups", async () => {
    const text = [
      ".card {",
      "  color: red;",
      "  @supports (display: grid) {",
      "    display: grid;",
      "    @media (min-width: 40rem) {",
      "      gap: 1rem;",
      "    }",
      "  }",
      "  background: white;",
      "}",
    ].join("\n");
    const target = cssTarget("selected", ".card", "/dist/app.css");
    target.facts[0]!.metadata.rulePath = "0.0";
    target.facts.push(
      cssFact(".card", "display", "grid", "/dist/app.css", "0.0.0.0"),
      cssFact(".card", "gap", "1rem", "/dist/app.css", "0.0.0.1.0"),
      cssFact(".card", "background", "white", "/dist/app.css", "0.0.1"),
    );

    const result = await resolveCss(text, selection([target]));

    expect(result.matches).toHaveLength(4);
    expect(snippets(text, result.matches)).toEqual([
      text,
      text,
      text,
      text,
    ]);
  });

  it("counts interleaved and trailing CSSNestedDeclarations", async () => {
    const text = [
      ".card {",
      "  .first { color: red; }",
      "  display: grid;",
      "  .second { color: blue; }",
      "  gap: 1rem;",
      "}",
    ].join("\n");
    const target = cssTarget("selected", ".card", "/dist/app.css");
    target.facts[0]!.metadata.rulePath = "0.0.1";
    target.facts.push(
      cssFact(".card", "gap", "1rem", "/dist/app.css", "0.0.3"),
    );
    const first = cssTarget("selected", "& .first", "/dist/app.css");
    first.facts[0]!.metadata.rulePath = "0.0.0";
    const second = cssTarget("selected", "& .second", "/dist/app.css");
    second.facts[0]!.metadata.rulePath = "0.0.2";

    const result = await resolveCss(
      text,
      selection([target, first, second]),
    );

    expect(snippets(text, result.matches)).toEqual([
      text,
      text,
      ".first { color: red; }",
      ".second { color: blue; }",
    ]);
  });

  it("keeps nested media uncertainty local to its CSSRuleList", async () => {
    const text = [
      "@media (min-width: 40rem) {",
      "  @unknown demo;",
      "  .duplicate { color: red; }",
      "  .duplicate { color: blue; }",
      "}",
      ".outside { color: green; }",
    ].join("\n");
    const uncertain = cssTarget("selected", ".duplicate", "/dist/app.css");
    uncertain.facts[0]!.metadata.rulePath = "0.0.1";
    const trusted = cssTarget("parent", ".outside", "/dist/app.css");
    trusted.facts[0]!.metadata.rulePath = "0.1";

    const result = await resolveCss(text, selection([uncertain, trusted]));

    expect(snippets(text, result.matches)).toEqual([
      ".outside { color: green; }",
    ]);
  });

  it.each([
    {
      name: "implicit selector branches with nested commas and quoted commas",
      sourceSelector:
        ".title:is(.primary,.secondary), [data-label='a,b'], .escaped\\,comma",
      cssomSelector:
        '& .title:is(.primary, .secondary), & [data-label="a,b"], & .escaped\\,comma',
    },
    {
      name: "relative combinator branches",
      sourceSelector: "> .title, + .summary",
      cssomSelector: "& > .title, & + .summary",
    },
    {
      name: "mixed explicit and implicit branches",
      sourceSelector: "&.active, .child",
      cssomSelector: "&.active, & .child",
    },
  ])("maps nested $name per selector-list branch", async ({
    sourceSelector,
    cssomSelector,
  }) => {
    const text = [
      ".card {",
      `  ${sourceSelector} { color: red; }`,
      "}",
      ".panel {",
      `  ${sourceSelector} { color: blue; }`,
      "}",
    ].join("\n");
    const target = cssTarget("selected", cssomSelector, "/dist/app.css");
    target.facts[0]!.metadata.rulePath = "0.0.0";

    const result = await resolveCss(text, selection([target]));

    expect(snippets(text, result.matches)).toEqual([
      `${sourceSelector} { color: red; }`,
    ]);
  });

  it.each([
    ["selector-list comma spacing", ".a,.b", ".a, .b", "red"],
    ["combinator spacing", ".a>.b", ".a > .b", "blue"],
    [
      "attribute quote serialization",
      "[data-kind='card']",
      '[data-kind="card"]',
      "green",
    ],
  ])("matches CSSOM %s at the exact rule path", async (
    _name,
    sourceSelector,
    cssomSelector,
    color,
  ) => {
    const text = `${sourceSelector} { color: ${color}; }`;
    const target = cssTarget("selected", cssomSelector, "/dist/app.css");
    target.facts[0]!.metadata.rulePath = "0.0";

    const result = await resolveCss(text, selection([target]));

    expect(snippets(text, result.matches)).toEqual([text]);
  });

  it("matches CSSOM media colon spacing at the exact nested path", async () => {
    const text = [
      "@media (min-width:40rem) {",
      "  .card { color: red; }",
      "}",
      "@media (min-width: 60rem) {",
      "  .card { color: blue; }",
      "}",
    ].join("\n");
    const target = cssTarget("selected", ".card", "/dist/app.css");
    target.facts[0]!.metadata.rulePath = "0.0.0";
    target.facts[0]!.metadata.media = ["(min-width: 40rem)"];

    const result = await resolveCss(text, selection([target]));

    expect(snippets(text, result.matches)).toEqual([
      ".card { color: red; }",
    ]);
  });

  it("rejects oversized media metadata for pathless fallback", async () => {
    const media = "x".repeat(INSPECT_LIMITS.valueLength + 1);
    const text = `@media ${media} { .card { color: red; } }`;
    const target = cssTarget("selected", ".card", "/dist/app.css");
    target.facts[0]!.metadata.media = [media];

    const result = await resolveCss(text, selection([target]));

    expect(result.matches).toEqual([]);
  });

  it("does not count a leading charset declaration in CSSOM rule paths", async () => {
    const text = [
      '@charset "UTF-8";',
      ".duplicate { color: red; }",
      ".duplicate { color: blue; }",
    ].join("\n");
    const target = cssTarget("selected", ".duplicate", "/dist/app.css");
    target.facts[0]!.metadata.rulePath = "0.1";

    const result = await resolveCss(text, selection([target]));

    expect(snippets(text, result.matches)).toEqual([
      ".duplicate { color: blue; }",
    ]);
  });

  it.each([
    {
      name: "an unknown at-rule",
      prefix: "@unknown demo;",
      path: "0.1",
    },
    {
      name: "an invalid selector",
      prefix: ".broken,, .selector { color: black; }",
      path: "0.1",
    },
    {
      name: "a misplaced import",
      prefix: ".before { color: black; }\n@import url('late.css');",
      path: "0.2",
    },
    {
      name: "a misplaced namespace",
      prefix: ".before { color: black; }\n@namespace svg url(http://www.w3.org/2000/svg);",
      path: "0.2",
    },
    {
      name: "a malformed known group rule",
      prefix: "@media screen;",
      path: "0.1",
    },
    {
      name: "a malformed known leaf rule",
      prefix: "@font-face;",
      path: "0.1",
    },
  ])("fails closed after $name shifts a browser path", async ({
    prefix,
    path,
  }) => {
    const text = [
      prefix,
      ".duplicate { color: red; }",
      ".duplicate { color: blue; }",
    ].join("\n");
    const target = cssTarget("selected", ".duplicate", "/dist/app.css");
    target.facts[0]!.metadata.rulePath = path;

    const result = await resolveCss(text, selection([target]));

    expect(result.matches).toEqual([]);
  });

  it("preserves meaningful string whitespace in normalized selector metadata", () => {
    expect(normalizeSelector('  [data-label="a  b"]  ')).toBe(
      '[data-label="a  b"]',
    );
  });

  it("never falls back when a rule path is malformed, excessive, or unresolved", async () => {
    const malformed = cssTarget("selected", ".card", "/dist/app.css");
    malformed.facts[0]!.metadata.rulePath = "0.not-an-index";
    const excessive = cssTarget("parent", ".layout", "/dist/app.css");
    excessive.facts[0]!.metadata.rulePath = `0.${"1.".repeat(1000)}1`;
    const unresolved = cssTarget("selected", ".card", "/dist/app.css");
    unresolved.facts[0]!.metadata.rulePath = "0.99";

    const result = await resolveCss(
      ".layout { display: grid; }\n.card { color: red; }",
      selection([malformed, excessive, unresolved]),
    );

    expect(result.matches).toEqual([]);
  });

  it("does not use selector fallback for an invalidated path collision", () => {
    const ast = new StylesheetAstCache();
    const parsed = ast.parseText(
      "file:///workspace/dist/app.css",
      "css",
      ".card { color: red; }",
    );
    const collided = {
      ...parsed,
      pathIndex: new Map([["0", null]]),
    } as unknown as Parameters<typeof findMatchingCssRules>[0];
    const fact = cssFact(
      ".card",
      "color",
      "red",
      "/dist/app.css",
      "0.0",
    );

    expect(() =>
      findMatchingCssRules(collided, fact, parsed.document)
    ).not.toThrow();
    expect(findMatchingCssRules(collided, fact, parsed.document)).toEqual([]);
  });

  it("returns bounded exact duplicates only when rulePath is absent", async () => {
    const boundedText = [
      ".duplicate { color: red; }",
      ".duplicate { color: blue; }",
    ].join("\n");
    const bounded = await resolveCss(
      boundedText,
      selection([cssTarget("selected", ".duplicate", "/dist/app.css")]),
    );
    const oversizedText = Array.from(
      { length: 65 },
      (_, index) => `.duplicate { order: ${index}; }`,
    ).join("\n");
    const oversized = await resolveCss(
      oversizedText,
      selection([cssTarget("selected", ".duplicate", "/dist/app.css")]),
    );

    expect(bounded.matches).toHaveLength(2);
    expect(oversized.matches).toEqual([]);
  });

  it("uses precomputed indexes for path and fallback lookups", () => {
    const ast = new StylesheetAstCache();
    const parsed = ast.parseText(
      "file:///workspace/dist/app.css",
      "css",
      Array.from(
        { length: 1024 },
        (_, index) => `.rule-${index} { order: ${index}; }`,
      ).join("\n"),
    );
    const source = parsed.document;
    Object.defineProperty(parsed, "rules", {
      get(): never {
        throw new Error("lookup scanned ParsedStylesheet.rules");
      },
    });
    const byPath = cssFact(
      ".browser-serialized-selector",
      "order",
      "1023",
      "/dist/app.css",
      "0.1023",
    );
    const bySelector: CssRuleFact = {
      ...byPath,
      selector: ".rule-512",
      metadata: { sourceUrl: "/dist/app.css" },
    };

    expect(findMatchingCssRules(parsed, byPath, source).map(
      (rule) => rule.selector,
    )).toEqual([".rule-1023"]);
    expect(findMatchingCssRules(parsed, bySelector, source).map(
      (rule) => rule.selector,
    )).toEqual([".rule-512"]);
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
