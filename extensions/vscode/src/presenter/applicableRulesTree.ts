import type * as vscode from "vscode";
import type { ReferenceSnapshot } from "../references/referenceStore.js";
import type { ResolvedReference } from "../references/sourceTypes.js";

export interface ApplicableRuleTreeItem extends vscode.TreeItem {
  readonly referenceId: string;
  readonly reference: ResolvedReference;
}

export interface ApplicableRulesTreeOptions {
  readonly createThemeIcon?: (id: string) => vscode.ThemeIcon;
}

export class ApplicableRulesTreeDataProvider {
  private readonly createThemeIcon: (id: string) => vscode.ThemeIcon;
  private readonly changeListeners = new Set<
    (item: ApplicableRuleTreeItem | undefined | null) => unknown
  >();
  private items: ApplicableRuleTreeItem[] = [];
  private referencesById = new Map<string, ResolvedReference>();

  public readonly onDidChangeTreeData: vscode.Event<
    ApplicableRuleTreeItem | undefined | null
  > = (listener, thisArgs, disposables) => {
    const wrapped = thisArgs
      ? (item: ApplicableRuleTreeItem | undefined | null) =>
          listener.call(thisArgs, item)
      : listener;
    this.changeListeners.add(wrapped);
    const disposable = {
      dispose: () => this.changeListeners.delete(wrapped),
    };
    disposables?.push(disposable);
    return disposable;
  };

  public constructor(options: ApplicableRulesTreeOptions = {}) {
    this.createThemeIcon =
      options.createThemeIcon ?? ((id) => ({ id }) as vscode.ThemeIcon);
  }

  public update(snapshot: ReferenceSnapshot): void {
    this.referencesById = new Map();
    this.items = snapshot.references.map((reference) => {
      const referenceId = stableReferenceId(reference);
      this.referencesById.set(referenceId, reference);
      return {
        label: formatReferenceLabel(reference),
        description: reference.status,
        tooltip: formatReferenceTooltip(reference),
        iconPath: this.createThemeIcon(referenceIcon(reference)),
        command: {
          command: "browser2ide.openReference",
          title: "Open Reference",
          arguments: [referenceId],
        },
        contextValue: "browser2ide.reference",
        referenceId,
        reference,
      };
    });
    for (const listener of this.changeListeners) {
      listener(undefined);
    }
  }

  public getChildren(): ApplicableRuleTreeItem[] {
    return [...this.items];
  }

  public getTreeItem(item: ApplicableRuleTreeItem): ApplicableRuleTreeItem {
    return item;
  }

  public getReference(referenceId: string): ResolvedReference | undefined {
    return this.referencesById.get(referenceId);
  }

  public getReferences(): readonly ResolvedReference[] {
    return this.items.map((item) => item.reference);
  }

  public dispose(): void {
    this.changeListeners.clear();
    this.items = [];
    this.referencesById.clear();
  }
}

export function stableReferenceId(reference: ResolvedReference): string {
  return encodeURIComponent(
    JSON.stringify([
      reference.kind,
      reference.source.uri,
      reference.source.line,
      reference.source.column,
      reference.source.endLine ?? null,
      reference.source.endColumn ?? null,
      reference.label,
    ]),
  );
}

function formatReferenceLabel(reference: ResolvedReference): string {
  return `${referenceFileName(reference)}:${reference.source.line} ${reference.label}`;
}

function formatReferenceTooltip(reference: ResolvedReference): string {
  return [
    `${reference.status}: ${reference.source.uri}:${reference.source.line}:${reference.source.column}`,
    ...reference.diagnostics,
  ].join("\n");
}

function referenceIcon(reference: ResolvedReference): string {
  if (reference.status === "external") {
    return "circle-slash";
  }
  if (
    reference.status === "unmapped" ||
    reference.status === "error" ||
    reference.confidence === "heuristic" ||
    reference.confidence === "unknown"
  ) {
    return "warning";
  }
  return "check";
}

function referenceFileName(reference: ResolvedReference): string {
  const value = reference.workspaceUri?.fsPath ?? sourcePath(reference.source.uri);
  const normalized = value.replace(/\\/g, "/").replace(/\/$/, "");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(name) || value;
  } catch {
    return name || value;
  }
}

function sourcePath(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return value;
  }
}
