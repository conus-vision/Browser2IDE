import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import {
  SOURCE_PLUGIN_API_VERSION,
  type SourcePlugin,
  type SourceWorkspace,
} from "@browser2ide/plugin-api";
import {
  PROTOCOL_VERSION,
  type InspectMessage,
} from "@browser2ide/protocol";
import { createPresenterRuntime } from "../src/presenter/runtime.js";
import { SourcePluginRegistry } from "../src/sourcePlugins/registry.js";

describe("presenter runtime", () => {
  it("registers built-ins, retains selection, and publishes active-document matches", async () => {
    const harness = runtimeHarness({ activeLanguageId: "scss" });
    harness.runtime.select(inspectMessageWithSelectedAndParent());
    await harness.flush();

    expect(harness.registeredPluginIds).toEqual([
      "browser2ide.css",
      "browser2ide.scss",
    ]);
    expect(harness.openDocumentCalls).toBe(0);
    expect(harness.runtime.tree.getDocumentUri()).toBe(
      "file:///workspace/src/layout.scss",
    );
  });

  it("re-resolves after an external plugin is registered and disposed", async () => {
    const harness = runtimeHarness({ activeLanguageId: "fixture" });
    harness.runtime.select(inspectMessageWithCustomFact());
    const registration = harness.runtime.api.registerSourcePlugin(
      fixturePlugin(),
    );
    await harness.flush();
    expect(harness.runtime.tree.getMatches()).toHaveLength(1);

    registration.dispose();
    await harness.flush();
    expect(harness.runtime.tree.getMatches()).toEqual([]);
  });

  it("disposes coordinator, commands, tree, decorations, and built-ins", () => {
    const harness = runtimeHarness({ activeLanguageId: "css" });
    harness.runtime.dispose();
    harness.runtime.dispose();

    expect(harness.disposed).toEqual([
      "active-editor-listener",
      "document-listener",
      "command",
      "tree-registration",
      "primary",
      "context",
    ]);
  });
});

function runtimeHarness(options: { readonly activeLanguageId: string }) {
  const registeredPluginIds: string[] = [];
  const disposed: string[] = [];
  const registry = new SourcePluginRegistry();
  const originalRegister = registry.register.bind(registry);
  registry.register = ((plugin: SourcePlugin) => {
    registeredPluginIds.push(plugin.id);
    return originalRegister(plugin);
  }) as SourcePluginRegistry["register"];
  const uri = options.activeLanguageId === "scss"
    ? "file:///workspace/src/layout.scss"
    : `file:///workspace/src/app.${options.activeLanguageId}`;
  const text = options.activeLanguageId === "fixture"
    ? "fixture block"
    : ".layout {}";
  const editor = {
    document: textDocument(uri, options.activeLanguageId, text),
    setDecorations() {},
  };
  const runtime = createPresenterRuntime({
    registry,
    workspace: workspace(),
    host: {
      getActiveEditor: () => editor,
      onDidChangeActiveEditor: () => disposable(
        () => disposed.push("active-editor-listener"),
      ),
      onDidChangeTextDocument: () => disposable(
        () => disposed.push("document-listener"),
      ),
      createThemeIcon: (id) => ({ id }) as vscode.ThemeIcon,
      createThemeColor: (id) => ({ id }) as vscode.ThemeColor,
      overviewRulerLaneRight: 4,
      createDecorationType(_style, role) {
        return { role, dispose: () => disposed.push(role) };
      },
      createRange: (startLine, startCharacter, endLine, endCharacter) => ({
        start: { line: startLine, character: startCharacter },
        end: { line: endLine, character: endCharacter },
      }),
      registerTreeDataProvider: () => disposable(
        () => disposed.push("tree-registration"),
      ),
      registerCommand: () => disposable(() => disposed.push("command")),
      revealRange() {},
      selectRangeStart() {},
      reportError(error) {
        throw error;
      },
      workspaceFolders: [],
      findFiles: async () => [],
      parseUri: (value) => ({ toString: () => value }),
      readFile: async () => new Uint8Array(),
    },
  });
  return {
    runtime,
    registeredPluginIds,
    disposed,
    openDocumentCalls: 0,
    flush,
  };
}

function fixturePlugin(): SourcePlugin {
  return {
    id: "fixture.source",
    displayName: "Fixture Source",
    apiVersion: SOURCE_PLUGIN_API_VERSION,
    documentSelectors: [{ languageId: "fixture", scheme: "file" }],
    supportedFactKinds: ["fixture.source"],
    async resolve() {
      return {
        matches: [
          {
            targetRole: "selected",
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 7 },
            },
            label: "fixture",
            kind: "fixture",
            relation: "renders",
            confidence: "instrumented",
          },
        ],
      };
    },
  };
}

function inspectMessageWithSelectedAndParent(): InspectMessage {
  return inspect([
    cssTarget("selected", 0, ".layout > .card"),
    cssTarget("parent", 1, ".layout"),
  ]);
}

function inspectMessageWithCustomFact(): InspectMessage {
  return inspect([
    {
      role: "selected",
      depth: 0,
      subject: { selector: ".fixture", metadata: {} },
      facts: [
        {
          type: "fixture.source",
          payload: { component: "Fixture" },
          metadata: {},
        },
      ],
      metadata: {},
    },
  ]);
}

function inspect(targets: InspectMessage["targets"]): InspectMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "inspect",
    messageId: "inspect-1",
    sessionId: "session-1",
    source: { role: "browser", id: "firefox", metadata: {} },
    targets,
    context: { url: "http://localhost:4173/", metadata: {} },
    metadata: {},
  };
}

function cssTarget(
  role: "selected" | "parent",
  depth: 0 | 1,
  selector: string,
): InspectMessage["targets"][number] {
  return {
    role,
    depth,
    subject: { selector, metadata: {} },
    facts: [
      {
        type: "css-rule",
        selector,
        property: "display",
        value: "grid",
        metadata: { sourceUrl: "/dist/app.css" },
      },
    ],
    metadata: {},
  };
}

function textDocument(uri: string, languageId: string, text: string) {
  return {
    uri: { toString: () => uri },
    languageId,
    version: 1,
    getText: () => text,
    positionAt: (offset: number) => ({ line: 0, character: offset }),
    offsetAt: (position: { line: number; character: number }) =>
      position.character,
  };
}

function workspace(): SourceWorkspace {
  return {
    findFiles: async () => [],
    readText: async () => "",
    resolveSourceUri: async () => ({ uris: [], status: "not-found" }),
    resolveRelativeUri: (base, reference) => new URL(reference, base).toString(),
    isWorkspaceUri: () => true,
  };
}

function disposable(dispose: () => void) {
  return { dispose };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}
