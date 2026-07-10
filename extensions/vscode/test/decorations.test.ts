import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import {
  DECORATION_STYLES,
  ReferenceDecorationManager,
  decorationKind,
  referenceDecorationRange,
} from "../src/presenter/decorations.js";
import type { ResolvedReference } from "../src/references/sourceTypes.js";

describe("reference decorations", () => {
  it("converts complete one-based ranges and assigns confidence styles", () => {
    const mapped = reference({
      line: 18,
      column: 3,
      endLine: 25,
      endColumn: 2,
      confidence: "sourcemap",
      workspaceUri: uri("F:/workspace/card.scss"),
    });

    expect(
      referenceDecorationRange(mapped, (startLine, startColumn, endLine, endColumn) => ({
        start: { line: startLine, character: startColumn },
        end: { line: endLine, character: endColumn },
      })),
    ).toEqual({
      start: { line: 17, character: 2 },
      end: { line: 24, character: 1 },
    });
    expect(decorationKind(mapped)).toBe("matched");
    expect(decorationKind(reference({ confidence: "heuristic" }))).toBe(
      "heuristic",
    );
    expect(decorationKind(reference({ status: "unmapped" }))).toBe(
      "unresolved",
    );
    expect(decorationKind(reference({ status: "external" }))).toBe(
      "unresolved",
    );
    expect(DECORATION_STYLES).toMatchObject({
      matched: {
        backgroundColor: "rgba(46, 160, 67, 0.12)",
      },
      heuristic: {
        backgroundColor: "rgba(210, 153, 34, 0.14)",
      },
      unresolved: {
        opacity: "0.45",
        overviewRulerColor: "rgba(128, 128, 128, 0.75)",
      },
    });
  });

  it("groups the latest references and reapplies them when visible tabs change", () => {
    const firstUri = uri("F:/workspace/card.scss");
    const secondUri = uri("F:/workspace/layout.scss");
    const firstEditor = editor(firstUri);
    const secondEditor = editor(secondUri);
    let visibleEditors = [firstEditor];
    let visibleListener:
      | ((editors: readonly ReturnType<typeof editor>[]) => void)
      | undefined;
    let listenerDisposed = false;
    const disposedTypes: string[] = [];
    const manager = new ReferenceDecorationManager({
      createDecorationType(options) {
        const id = Object.entries(DECORATION_STYLES).find(
          ([, style]) => style === options,
        )?.[0];
        if (!id) {
          throw new Error("Unknown decoration style");
        }
        return {
          id,
          dispose: () => disposedTypes.push(id),
        };
      },
      createRange(startLine, startColumn, endLine, endColumn) {
        return {
          start: { line: startLine, character: startColumn },
          end: { line: endLine, character: endColumn },
        };
      },
      getVisibleEditors: () => visibleEditors,
      onDidChangeVisibleEditors(listener) {
        visibleListener = listener;
        return { dispose: () => (listenerDisposed = true) };
      },
    });

    manager.update([
      reference({ workspaceUri: firstUri, endLine: 3, endColumn: 2 }),
      reference({
        workspaceUri: firstUri,
        line: 5,
        endLine: 6,
        endColumn: 2,
        confidence: "heuristic",
      }),
      reference({
        workspaceUri: firstUri,
        line: 8,
        status: "unmapped",
      }),
      reference({ workspaceUri: secondUri, line: 12 }),
    ]);

    expect(firstEditor.calls.map(({ type, ranges }) => [type.id, ranges.length])).toEqual([
      ["matched", 1],
      ["heuristic", 1],
      ["unresolved", 1],
    ]);
    expect(firstEditor.calls[0].ranges[0]).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 2, character: 1 },
    });

    visibleEditors = [secondEditor];
    visibleListener?.(visibleEditors);

    expect(secondEditor.calls.map(({ type, ranges }) => [type.id, ranges.length])).toEqual([
      ["matched", 1],
      ["heuristic", 0],
      ["unresolved", 0],
    ]);

    manager.dispose();
    expect(listenerDisposed).toBe(true);
    expect(disposedTypes).toEqual(["matched", "heuristic", "unresolved"]);
  });
});

function editor(documentUri: vscode.Uri) {
  const calls: Array<{
    type: { id: string; dispose(): void };
    ranges: readonly unknown[];
  }> = [];
  return {
    document: { uri: documentUri },
    calls,
    setDecorations(
      type: { id: string; dispose(): void },
      ranges: readonly unknown[],
    ) {
      calls.push({ type, ranges });
    },
  };
}

function reference(
  overrides: {
    line?: number;
    column?: number;
    endLine?: number;
    endColumn?: number;
    confidence?: ResolvedReference["confidence"];
    status?: ResolvedReference["status"];
    workspaceUri?: vscode.Uri;
  } = {},
): ResolvedReference {
  return {
    kind: "style-rule",
    relation: "styles",
    label: ".card",
    source: {
      uri: overrides.workspaceUri?.toString() ?? "file:///workspace/card.scss",
      line: overrides.line ?? 1,
      column: overrides.column ?? 1,
      endLine: overrides.endLine,
      endColumn: overrides.endColumn,
      metadata: {},
    },
    confidence: overrides.confidence ?? "exact",
    status: overrides.status ?? "matched",
    metadata: {},
    workspaceUri: overrides.workspaceUri,
    diagnostics: [],
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
