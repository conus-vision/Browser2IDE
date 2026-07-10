import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import type {
  InspectMessage,
  RuntimeFact,
  SourceReference,
} from "@browser2ide/protocol";
import { ReferenceStore } from "../src/references/referenceStore.js";
import { SourceResolverRegistry } from "../src/references/sourceResolverRegistry.js";
import type {
  ResolveInput,
  ResolvedReference,
  SourceResolver,
} from "../src/references/sourceTypes.js";
import {
  findRuleRangeBySelector,
  findWorkspaceFileByUrl,
  findWorkspaceFilesByBasename,
  readText,
  type WorkspaceFileApi,
} from "../src/references/workspaceFiles.js";

describe("ReferenceStore", () => {
  it("keeps only the latest message snapshot for each session", () => {
    const store = new ReferenceStore();
    const first = store.replace("session-1", "inspect-1", [
      reference({ label: ".first", uri: "file:///workspace/first.scss" }),
    ]);
    const second = store.replace("session-1", "inspect-2", [
      reference({ label: ".second", uri: "file:///workspace/second.scss" }),
    ]);

    expect(first.messageId).toBe("inspect-1");
    expect(store.getByMessageId("inspect-1")).toBeUndefined();
    expect(store.getByMessageId("inspect-2")).toEqual(second);
    expect(store.getLatestForSession("session-1")).toEqual(second);
  });

  it("sorts references and groups every local, external, and unmapped item", () => {
    const store = new ReferenceStore();
    const snapshot = store.replace("session-1", "inspect-1", [
      reference({
        label: ".heuristic",
        uri: "file:///workspace/b.scss",
        line: 10,
        confidence: "heuristic",
      }),
      reference({
        label: ".external",
        uri: "https://cdn.example/bootstrap.css",
        confidence: "exact",
        status: "external",
      }),
      reference({
        label: ".late",
        uri: "file:///workspace/a.scss",
        line: 20,
        confidence: "exact",
        status: "active",
      }),
      reference({
        label: ".early",
        uri: "file:///workspace/a.scss",
        line: 2,
        confidence: "exact",
        status: "active",
      }),
      reference({
        label: ".missing",
        uri: "/missing/theme.scss",
        confidence: "unknown",
        status: "unmapped",
      }),
    ]);

    expect(snapshot.references.map(({ label }) => label)).toEqual([
      ".early",
      ".late",
      ".external",
      ".heuristic",
      ".missing",
    ]);
    expect([...snapshot.groups.keys()]).toEqual([
      "file:///workspace/a.scss",
      "https://cdn.example/bootstrap.css",
      "file:///workspace/b.scss",
      "/missing/theme.scss",
    ]);
    expect(snapshot.groups.get("file:///workspace/a.scss")).toHaveLength(2);
    expect(snapshot.groups.get("https://cdn.example/bootstrap.css")?.[0].status).toBe(
      "external",
    );
    expect(snapshot.groups.get("/missing/theme.scss")?.[0].status).toBe("unmapped");
  });
});

describe("SourceResolverRegistry", () => {
  it("calls only matching resolvers and deduplicates by source identity", async () => {
    const calls: string[] = [];
    const lowerConfidence = reference({
      label: ".card",
      uri: "file:///workspace/card.css",
      line: 4,
      confidence: "heuristic",
      diagnostics: ["generated css"],
    });
    const higherConfidence = reference({
      label: ".card",
      uri: "file:///workspace/card.css",
      line: 4,
      confidence: "sourcemap",
      diagnostics: ["mapped to scss"],
    });
    higherConfidence.workspaceUri = uri("C:/workspace/card.css");
    const cssResolver = resolver("css", ["css-rule"], async () => {
      calls.push("css");
      return [lowerConfidence];
    });
    const sourcemapResolver = resolver("sourcemap", ["css-rule"], async () => {
      calls.push("sourcemap");
      return [higherConfidence];
    });
    const domResolver = resolver("dom", ["dom-attribute"], async () => {
      calls.push("dom");
      return [];
    });
    const registry = new SourceResolverRegistry([
      cssResolver,
      sourcemapResolver,
      domResolver,
    ]);

    const resolved = await registry.resolve(resolveInput([cssFact()]));

    expect(calls).toEqual(["css", "sourcemap"]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      confidence: "sourcemap",
      diagnostics: ["generated css", "mapped to scss"],
    });
  });

  it("registers resolvers once and preserves distinct external references", async () => {
    const registry = new SourceResolverRegistry();
    const external = reference({
      label: ".external",
      uri: "https://cdn.example/theme.css",
      status: "external",
      confidence: "unknown",
    });
    const builtIn = resolver("external", ["css-rule"], async () => [external]);

    registry.register(builtIn);
    expect(() => registry.register(builtIn)).toThrow('Resolver "external" is registered');

    await expect(registry.resolve(resolveInput([cssFact()]))).resolves.toEqual([external]);
  });
});

describe("workspace file helpers", () => {
  it("finds URL paths and basenames and reads UTF-8 text", async () => {
    const appCss = uri("C:/workspace/examples/basic-css/dist/app.css");
    const otherCss = uri("C:/workspace/vendor/app.css");
    const api: WorkspaceFileApi = {
      async findFiles(pattern) {
        return pattern === "**/dist/app.css" ? [appCss] : [appCss, otherCss];
      },
      async readFile(target) {
        expect(target).toBe(appCss);
        return new TextEncoder().encode(".card { color: red; }");
      },
    };

    await expect(findWorkspaceFileByUrl("http://localhost/dist/app.css?v=1", api)).resolves.toBe(
      appCss,
    );
    await expect(findWorkspaceFilesByBasename("app.css", api)).resolves.toEqual([
      appCss,
      otherCss,
    ]);
    await expect(readText(appCss, api)).resolves.toBe(".card { color: red; }");
  });

  it("returns the complete balanced SCSS rule range", () => {
    const text = [
      "@media (min-width: 40rem) {",
      "  .card {",
      '    content: "}";',
      "    color: red;",
      "    &:hover {",
      "      color: blue;",
      "    }",
      "  }",
      "  .other { color: black; }",
      "}",
    ].join("\n");

    const range = findRuleRangeBySelector(text, ".card");

    expect(range).toBeDefined();
    expect(text.slice(range!.startOffset, range!.endOffset)).toBe(
      [
        ".card {",
        '    content: "}";',
        "    color: red;",
        "    &:hover {",
        "      color: blue;",
        "    }",
        "  }",
      ].join("\n"),
    );
    expect(range).toMatchObject({
      start: { line: 1, character: 2 },
      end: { line: 7, character: 3 },
    });

    const commented = "/* component rule */\n.card { color: red; }";
    const commentedRange = findRuleRangeBySelector(commented, ".card");
    expect(commented.slice(commentedRange!.startOffset, commentedRange!.endOffset)).toBe(
      ".card { color: red; }",
    );
    expect(commentedRange?.start).toEqual({ line: 1, character: 0 });

    const interpolated = ".card-#{$variant} { color: red; }";
    const interpolatedRange = findRuleRangeBySelector(
      interpolated,
      ".card-#{$variant}",
    );
    expect(
      interpolated.slice(
        interpolatedRange!.startOffset,
        interpolatedRange!.endOffset,
      ),
    ).toBe(interpolated);
  });
});

function reference(
  overrides: {
    label?: string;
    uri?: string;
    line?: number;
    confidence?: SourceReference["confidence"];
    status?: SourceReference["status"];
    diagnostics?: string[];
  } = {},
): ResolvedReference {
  return {
    kind: "style-rule",
    relation: "styles",
    label: overrides.label ?? ".card",
    source: {
      uri: overrides.uri ?? "file:///workspace/card.scss",
      line: overrides.line ?? 1,
      column: 1,
      metadata: {},
    },
    confidence: overrides.confidence ?? "exact",
    status: overrides.status ?? "matched",
    metadata: {},
    diagnostics: overrides.diagnostics ?? [],
  };
}

function resolver(
  id: string,
  supportedFactKinds: string[],
  resolve: SourceResolver["resolve"],
): SourceResolver {
  return { id, supportedFactKinds, resolve };
}

function resolveInput(facts: RuntimeFact[]): ResolveInput {
  const message: InspectMessage = {
    protocolVersion: 1,
    type: "inspect",
    messageId: "inspect-1",
    sessionId: "session-1",
    source: { role: "browser", id: "browser-1", metadata: {} },
    subject: { selector: ".card", metadata: {} },
    facts,
    context: { url: "http://localhost", metadata: {} },
    metadata: {},
  };

  return { message, facts };
}

function cssFact(): RuntimeFact {
  return {
    type: "css-rule",
    selector: ".card",
    property: "color",
    value: "red",
    metadata: {},
  };
}

function uri(fsPath: string): vscode.Uri {
  return {
    fsPath,
    path: `/${fsPath.replace(/\\/g, "/")}`,
    toString: () => `file:///${fsPath.replace(/\\/g, "/")}`,
  } as vscode.Uri;
}
