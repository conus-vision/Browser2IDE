import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import type { InspectMessage } from "@browser2ide/protocol";
import { ReferenceStore } from "../src/references/referenceStore.js";
import {
  InspectPresenter,
  ReferenceNavigator,
} from "../src/presenter/openReferences.js";
import type { ResolvedReference } from "../src/references/sourceTypes.js";

describe("ReferenceNavigator", () => {
  it("opens only the highest-confidence local reference when open-all is disabled", async () => {
    const heuristic = reference({
      workspaceUri: uri("F:/workspace/dist/app.css"),
      confidence: "heuristic",
      line: 4,
    });
    const mapped = reference({
      workspaceUri: uri("F:/workspace/src/card.scss"),
      confidence: "sourcemap",
      line: 18,
      endLine: 24,
      endColumn: 2,
    });
    const external = reference({
      uri: "https://cdn.example/vendor.css",
      status: "external",
    });
    const host = navigationHost();
    const navigator = new ReferenceNavigator(host.api);

    await navigator.openReferences([heuristic, external, mapped], false);

    expect(host.opened).toEqual([mapped.workspaceUri?.toString()]);
    expect(host.shown).toEqual([
      {
        uri: mapped.workspaceUri?.toString(),
        options: { preview: false, preserveFocus: false },
      },
    ]);
    expect(host.revealed).toEqual([
      {
        uri: mapped.workspaceUri?.toString(),
        range: {
          start: { line: 17, character: 0 },
          end: { line: 23, character: 1 },
        },
      },
    ]);
  });

  it("opens every unique local file while preserving focus on the best reference", async () => {
    const primaryUri = uri("F:/workspace/src/card.scss");
    const secondaryUri = uri("F:/workspace/dist/layout.css");
    const primary = reference({
      workspaceUri: primaryUri,
      confidence: "sourcemap",
      line: 18,
    });
    const duplicateFile = reference({
      workspaceUri: primaryUri,
      confidence: "heuristic",
      line: 30,
    });
    const secondary = reference({
      workspaceUri: secondaryUri,
      confidence: "heuristic",
      line: 6,
    });
    const host = navigationHost();
    const navigator = new ReferenceNavigator(host.api);

    await navigator.openReferences([secondary, duplicateFile, primary], true);

    expect(host.opened).toEqual([
      primaryUri.toString(),
      secondaryUri.toString(),
    ]);
    expect(host.shown).toEqual([
      {
        uri: primaryUri.toString(),
        options: { preview: false, preserveFocus: false },
      },
      {
        uri: secondaryUri.toString(),
        options: { preview: false, preserveFocus: true },
      },
    ]);
    expect(host.revealed.map(({ uri: revealedUri }) => revealedUri)).toEqual([
      primaryUri.toString(),
      secondaryUri.toString(),
    ]);
  });
});

describe("InspectPresenter", () => {
  it("suppresses stale inspect results that resolve after a newer click", async () => {
    const pending = new Map<
      string,
      (references: readonly ResolvedReference[]) => void
    >();
    const treeMessages: string[] = [];
    const decorated: string[][] = [];
    const opened: string[][] = [];
    const presenter = new InspectPresenter({
      resolver: {
        resolve({ message }) {
          return new Promise((resolve) => pending.set(message.messageId, resolve));
        },
      },
      store: new ReferenceStore(),
      tree: {
        update(snapshot) {
          treeMessages.push(snapshot.messageId);
        },
      },
      decorations: {
        update(references) {
          decorated.push(references.map(({ label }) => label));
        },
      },
      navigator: {
        async openReferences(references) {
          opened.push(references.map(({ label }) => label));
        },
      },
    });

    const first = presenter.present(inspect("inspect-1"), true);
    const second = presenter.present(inspect("inspect-2"), true);
    pending.get("inspect-2")?.([reference({ label: ".new" })]);
    await second;
    pending.get("inspect-1")?.([reference({ label: ".old" })]);
    await first;

    expect(treeMessages).toEqual(["inspect-2"]);
    expect(decorated).toEqual([[".new"]]);
    expect(opened).toEqual([[".new"]]);
  });

  it("ignores a stale resolver failure after a newer inspect succeeds", async () => {
    let rejectFirst: ((error: unknown) => void) | undefined;
    const presenter = new InspectPresenter({
      resolver: {
        resolve({ message }) {
          if (message.messageId === "inspect-1") {
            return new Promise((_, reject) => (rejectFirst = reject));
          }
          return Promise.resolve([]);
        },
      },
      store: new ReferenceStore(),
      tree: { update() {} },
      decorations: { update() {} },
      navigator: { async openReferences() {} },
    });

    const first = presenter.present(inspect("inspect-1"), true);
    await presenter.present(inspect("inspect-2"), true);
    rejectFirst?.(new Error("stale failure"));

    await expect(first).resolves.toBe(false);
  });
});

function navigationHost() {
  const opened: string[] = [];
  const shown: Array<{
    uri: string;
    options: { preview: false; preserveFocus: boolean };
  }> = [];
  const revealed: Array<{ uri: string; range: unknown }> = [];
  return {
    opened,
    shown,
    revealed,
    api: {
      async openTextDocument(target: vscode.Uri) {
        const document = { uri: target };
        opened.push(target.toString());
        return document;
      },
      async showTextDocument(
        document: { uri: vscode.Uri },
        options: { preview: false; preserveFocus: boolean },
      ) {
        shown.push({ uri: document.uri.toString(), options });
        return { document };
      },
      createRange(startLine: number, startColumn: number, endLine: number, endColumn: number) {
        return {
          start: { line: startLine, character: startColumn },
          end: { line: endLine, character: endColumn },
        };
      },
      revealRange(
        editor: { document: { uri: vscode.Uri } },
        range: unknown,
      ) {
        revealed.push({ uri: editor.document.uri.toString(), range });
      },
    },
  };
}

function reference(
  overrides: {
    label?: string;
    uri?: string;
    workspaceUri?: vscode.Uri;
    confidence?: ResolvedReference["confidence"];
    status?: ResolvedReference["status"];
    line?: number;
    endLine?: number;
    endColumn?: number;
  },
): ResolvedReference {
  return {
    kind: "style-rule",
    relation: "styles",
    label: overrides.label ?? ".card",
    source: {
      uri: overrides.uri ?? overrides.workspaceUri?.toString() ?? "file:///card.scss",
      line: overrides.line ?? 1,
      column: 1,
      endLine: overrides.endLine,
      endColumn: overrides.endColumn,
      metadata: {},
    },
    confidence: overrides.confidence ?? "unknown",
    status: overrides.status ?? "matched",
    metadata: {},
    workspaceUri: overrides.workspaceUri,
    diagnostics: [],
  };
}

function inspect(messageId: string): InspectMessage {
  return {
    protocolVersion: 1,
    type: "inspect",
    messageId,
    sessionId: "session-1",
    source: { role: "browser", id: "browser-1", metadata: {} },
    subject: { selector: ".card", metadata: {} },
    facts: [],
    context: { url: "http://localhost:3000", metadata: {} },
    metadata: {},
  };
}

function uri(fsPath: string): vscode.Uri {
  const normalized = fsPath.replace(/\\/g, "/");
  return {
    fsPath,
    path: `/${normalized}`,
    toString: () => `file:///${normalized}`,
  } as vscode.Uri;
}
