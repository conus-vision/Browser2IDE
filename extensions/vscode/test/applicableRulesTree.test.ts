import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import {
  ApplicableRulesTreeDataProvider,
  stableReferenceId,
} from "../src/presenter/applicableRulesTree.js";
import type { ReferenceSnapshot } from "../src/references/referenceStore.js";
import type { ResolvedReference } from "../src/references/sourceTypes.js";

describe("ApplicableRulesTreeDataProvider", () => {
  it("shows file locations with status icons and stable open commands", () => {
    const mapped = reference({
      label: ".card",
      line: 18,
      confidence: "sourcemap",
      workspaceUri: uri("F:/workspace/styles/card.scss"),
      diagnostics: ["Mapped through app.css.map"],
    });
    const heuristic = reference({
      label: ".fallback",
      line: 7,
      confidence: "heuristic",
      workspaceUri: uri("F:/workspace/dist/app.css"),
    });
    const unmapped = reference({
      label: ".missing",
      line: 3,
      status: "unmapped",
      uri: "/styles/missing.css",
    });
    const external = reference({
      label: ".vendor",
      status: "external",
      uri: "https://cdn.example/vendor.css",
    });
    const provider = new ApplicableRulesTreeDataProvider({
      createThemeIcon: (id) => ({ id }) as vscode.ThemeIcon,
    });

    provider.update(snapshot([mapped, heuristic, unmapped, external]));
    const items = provider.getChildren();

    expect(items.map(({ label, iconPath }) => [label, iconPath])).toEqual([
      ["card.scss:18 .card", { id: "check" }],
      ["app.css:7 .fallback", { id: "warning" }],
      ["missing.css:3 .missing", { id: "warning" }],
      ["vendor.css:1 .vendor", { id: "circle-slash" }],
    ]);
    expect(items[0].command).toEqual({
      command: "browser2ide.openReference",
      title: "Open Reference",
      arguments: [stableReferenceId(mapped)],
    });
    expect(items[0].tooltip).toContain("Mapped through app.css.map");
    expect(provider.getReferences()).toEqual([
      mapped,
      heuristic,
      unmapped,
      external,
    ]);

    provider.update(snapshot([mapped]));
    expect(provider.getChildren()[0].referenceId).toBe(stableReferenceId(mapped));
    expect(provider.getReference(stableReferenceId(mapped))).toBe(mapped);
  });

  it("notifies the tree on updates and releases listeners when disposed", () => {
    const provider = new ApplicableRulesTreeDataProvider();
    const updates: Array<unknown> = [];
    provider.onDidChangeTreeData((item) => updates.push(item));

    provider.update(snapshot([]));
    provider.dispose();
    provider.update(snapshot([]));

    expect(updates).toEqual([undefined]);
  });
});

function snapshot(references: readonly ResolvedReference[]): ReferenceSnapshot {
  return {
    sessionId: "session-1",
    messageId: "inspect-1",
    references,
    groups: new Map(),
  };
}

function reference(
  overrides: {
    label: string;
    line?: number;
    uri?: string;
    confidence?: ResolvedReference["confidence"];
    status?: ResolvedReference["status"];
    workspaceUri?: vscode.Uri;
    diagnostics?: string[];
  },
): ResolvedReference {
  return {
    kind: "style-rule",
    relation: "styles",
    label: overrides.label,
    source: {
      uri: overrides.uri ?? overrides.workspaceUri?.toString() ?? "file:///style.css",
      line: overrides.line ?? 1,
      column: 1,
      metadata: {},
    },
    confidence: overrides.confidence ?? "unknown",
    status: overrides.status ?? "matched",
    metadata: {},
    workspaceUri: overrides.workspaceUri,
    diagnostics: overrides.diagnostics ?? [],
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
