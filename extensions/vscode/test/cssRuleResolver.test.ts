import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import { SourceMapGenerator } from "source-map";
import type {
  CssRuleFact,
  InspectMessage,
  RuntimeFact,
  SourceLocation,
} from "@browser2ide/protocol";
import { CssRuleResolver } from "../src/references/cssRuleResolver.js";
import type { ResolvedReference } from "../src/references/sourceTypes.js";
import type { WorkspaceFileApi } from "../src/references/workspaceFiles.js";

const exampleRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../examples/basic-css",
);
const fixtureFiles = [
  resolve(exampleRoot, "index.html"),
  resolve(exampleRoot, "src/card.scss"),
  resolve(exampleRoot, "src/layout.scss"),
  resolve(exampleRoot, "dist/app.css"),
  resolve(exampleRoot, "dist/app.css.map"),
  resolve(exampleRoot, "fallback.css"),
];

describe("CssRuleResolver", () => {
  it("prefers source-mapped SCSS and returns complete card and featured rules", async () => {
    const resolver = new CssRuleResolver({ workspace: fileWorkspace(fixtureFiles) });

    const references = await resolver.resolve(
      input([
        cssFact(".card", "/dist/app.css"),
        cssFact(".featured", "/dist/app.css"),
      ]),
    );

    expect(references).toHaveLength(2);
    const card = byLabel(references, ".card");
    const featured = byLabel(references, ".featured");

    expect(card).toMatchObject({
      kind: "style-rule",
      relation: "styles",
      confidence: "sourcemap",
      status: "matched",
    });
    expect(
      card.workspaceUri?.fsPath
        .replace(/\\/g, "/")
        .endsWith("/examples/basic-css/src/card.scss"),
    ).toBe(true);
    expect(card.source.metadata).toMatchObject({
      generatedSourceUrl: "/dist/app.css",
    });
    await expect(sourceSnippet(card)).resolves.toContain("&:hover {");
    await expect(sourceSnippet(card)).resolves.toMatch(/^\.card \{[\s\S]*\}$/);

    expect(featured.confidence).toBe("sourcemap");
    expect(
      featured.workspaceUri?.fsPath
        .replace(/\\/g, "/")
        .endsWith("/examples/basic-css/src/card.scss"),
    ).toBe(true);
    await expect(sourceSnippet(featured)).resolves.toMatch(
      /^\.featured \{[\s\S]*box-shadow:[\s\S]*\}$/,
    );
  });

  it("maps the source URL to generated CSS when source-map lookup fails", async () => {
    const workspace = fileWorkspace(
      fixtureFiles.filter((file) => !file.endsWith(".map")),
    );
    const resolver = new CssRuleResolver({ workspace });

    const [reference] = await resolver.resolve(
      input([cssFact(".card", "/dist/app.css")]),
    );

    expect(reference).toMatchObject({
      label: ".card",
      confidence: "heuristic",
      status: "matched",
    });
    expect(
      reference.workspaceUri?.fsPath
        .replace(/\\/g, "/")
        .endsWith("/examples/basic-css/dist/app.css"),
    ).toBe(true);
    expect(reference.diagnostics).toContain("Source map was not found");
    expect(reference.metadata.errorCode).toBe("resolver.sourceMapFailed");
    await expect(sourceSnippet(reference)).resolves.toBe(
      ".card {\n  display: flex;\n  padding: 1rem;\n}",
    );
  });

  it("coalesces declaration facts that belong to the same CSS rule", async () => {
    const resolver = new CssRuleResolver({ workspace: fileWorkspace(fixtureFiles) });
    const paddingFact = {
      ...cssFact(".card", "/dist/app.css"),
      property: "padding",
      value: "1rem",
    };

    const references = await resolver.resolve(
      input([cssFact(".card", "/dist/app.css"), paddingFact]),
    );

    expect(references).toHaveLength(1);
    expect(references[0].label).toBe(".card");
  });

  it("keeps missing and external stylesheet facts visible", async () => {
    const resolver = new CssRuleResolver({ workspace: fileWorkspace(fixtureFiles) });

    const references = await resolver.resolve(
      input([
        cssFact(".missing", "/dist/missing.css"),
        cssFact(".external", "https://cdn.example/bootstrap.css"),
      ]),
    );

    expect(byLabel(references, ".missing")).toMatchObject({
      status: "unmapped",
      confidence: "unknown",
    });
    expect(byLabel(references, ".missing").workspaceUri).toBeUndefined();
    expect(byLabel(references, ".missing").metadata.errorCode).toBe(
      "resolver.fileNotFound",
    );
    expect(byLabel(references, ".external")).toMatchObject({
      status: "external",
      confidence: "unknown",
    });
    expect(byLabel(references, ".external").workspaceUri).toBeUndefined();
  });

  it("resolves every deterministic E2E fixture category", async () => {
    const resolver = new CssRuleResolver({ workspace: fileWorkspace(fixtureFiles) });

    const references = await resolver.resolve(
      input([
        cssFact(".card", "/dist/app.css"),
        cssFact(".layout > .card", "/dist/app.css"),
        cssFact(".card", "/fallback.css"),
        cssFact(".card", "/virtual.css"),
        cssFact(".card", "http://127.0.0.1:4174/vendor.css"),
      ]),
    );

    expect(references).toHaveLength(5);
    expect(
      references
        .filter((reference) => reference.confidence === "sourcemap")
        .map((reference) =>
          reference.workspaceUri?.fsPath.replace(/\\/g, "/").split("/").at(-1),
        ),
    ).toEqual(["card.scss", "layout.scss"]);
    expect(
      references.find((reference) =>
        reference.workspaceUri?.fsPath.endsWith("fallback.css"),
      ),
    ).toMatchObject({ confidence: "heuristic", status: "matched" });
    expect(
      references.find((reference) => reference.source.uri === "/virtual.css"),
    ).toMatchObject({ status: "unmapped" });
    expect(
      references.find((reference) => reference.status === "external"),
    ).toMatchObject({
      source: { uri: "http://127.0.0.1:4174/vendor.css" },
    });
  });

  it("uses the mapped position when a source file repeats a selector", async () => {
    const originalText = [
      ".card {",
      "  color: red;",
      "}",
      "",
      ".card {",
      "  color: blue;",
      "}",
    ].join("\n");
    const generatedText = ".card {\n  color: blue;\n}";
    const map = new SourceMapGenerator({ file: "duplicate.css" });
    map.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 5, column: 0 },
      source: "../src/duplicate.scss",
    });
    const workspace = memoryWorkspace({
      "F:/fixture/dist/duplicate.css": generatedText,
      "F:/fixture/dist/duplicate.css.map": map.toString(),
      "F:/fixture/src/duplicate.scss": originalText,
    });
    const resolver = new CssRuleResolver({ workspace });

    const [reference] = await resolver.resolve(
      input([cssFact(".card", "/dist/duplicate.css")]),
    );

    expect(reference.confidence).toBe("sourcemap");
    expect(sliceLocation(originalText, reference.source)).toBe(
      ".card {\n  color: blue;\n}",
    );
  });

  it("uses a fact source position when generated CSS repeats a selector", async () => {
    const generatedText = [
      ".card {",
      "  color: red;",
      "}",
      "",
      ".card {",
      "  color: blue;",
      "}",
    ].join("\n");
    const workspace = memoryWorkspace({
      "F:/fixture/dist/repeated.css": generatedText,
    });
    const resolver = new CssRuleResolver({ workspace });
    const fact: CssRuleFact = {
      ...cssFact(".card", "/dist/repeated.css"),
      source: {
        uri: "/dist/repeated.css",
        line: 5,
        column: 1,
        metadata: {},
      },
    };

    const [reference] = await resolver.resolve(input([fact]));

    expect(reference.confidence).toBe("heuristic");
    expect(sliceLocation(generatedText, reference.source)).toBe(
      ".card {\n  color: blue;\n}",
    );
  });
});

function input(facts: RuntimeFact[]): {
  message: InspectMessage;
  facts: RuntimeFact[];
} {
  return {
    message: {
      protocolVersion: 2,
      type: "inspect",
      messageId: "inspect-css",
      sessionId: "session-1",
      source: { role: "browser", id: "browser-1", metadata: {} },
      targets: [
        {
          role: "selected",
          depth: 0,
          subject: { selector: ".card", metadata: {} },
          facts,
          metadata: {},
        },
      ],
      context: { url: "http://localhost:3000/page", metadata: {} },
      metadata: {},
    },
    facts,
  };
}

function cssFact(selector: string, sourceUrl: string): CssRuleFact {
  return {
    type: "css-rule",
    selector,
    property: "display",
    value: "block",
    metadata: { sourceUrl },
  };
}

function byLabel(
  references: readonly ResolvedReference[],
  label: string,
): ResolvedReference {
  const reference = references.find((candidate) => candidate.label === label);
  if (!reference) {
    throw new Error(`Reference not found: ${label}`);
  }
  return reference;
}

function fileWorkspace(files: readonly string[]): WorkspaceFileApi {
  const uris = files.map(uri);
  return {
    async findFiles(pattern) {
      const suffix = pattern
        .replace(/^\*\*\//, "")
        .replace(/\[([\[\]{}*?])\]/g, "$1")
        .replace(/\\/g, "/");
      return uris.filter((candidate) =>
        candidate.fsPath.replace(/\\/g, "/").endsWith(`/${suffix}`),
      );
    },
    async readFile(target) {
      return readFile(target.fsPath);
    },
  };
}

function memoryWorkspace(files: Readonly<Record<string, string>>): WorkspaceFileApi {
  const entries = Object.entries(files).map(([path, contents]) => ({
    uri: uri(path),
    contents,
  }));
  return {
    async findFiles(pattern) {
      const suffix = pattern
        .replace(/^\*\*\//, "")
        .replace(/\[([\[\]{}*?])\]/g, "$1")
        .replace(/\\/g, "/");
      return entries
        .filter(({ uri: candidate }) =>
          candidate.fsPath.replace(/\\/g, "/").endsWith(`/${suffix}`),
        )
        .map(({ uri: candidate }) => candidate);
    },
    async readFile(target) {
      const entry = entries.find(
        ({ uri: candidate }) => candidate.fsPath === target.fsPath,
      );
      if (!entry) {
        throw new Error(`Memory file not found: ${target.fsPath}`);
      }
      return new TextEncoder().encode(entry.contents);
    },
  };
}

function uri(fsPath: string): vscode.Uri {
  const normalized = fsPath.replace(/\\/g, "/");
  return {
    fsPath,
    path: normalized.startsWith("/") ? normalized : `/${normalized}`,
    toString: () => `file://${normalized.startsWith("/") ? "" : "/"}${normalized}`,
  } as vscode.Uri;
}

async function sourceSnippet(reference: ResolvedReference): Promise<string> {
  if (!reference.workspaceUri) {
    throw new Error("Reference has no workspace URI");
  }
  const text = await readFile(reference.workspaceUri.fsPath, "utf8");
  return sliceLocation(text, reference.source);
}

function sliceLocation(text: string, location: SourceLocation): string {
  if (location.endLine === undefined || location.endColumn === undefined) {
    throw new Error("Reference has no end position");
  }
  return text.slice(
    offsetAt(text, location.line, location.column),
    offsetAt(text, location.endLine, location.endColumn),
  );
}

function offsetAt(text: string, line: number, column: number): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let index = 0; index < line - 1; index += 1) {
    offset += lines[index].length + 1;
  }
  return offset + column - 1;
}
