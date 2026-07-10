import type * as vscode from "vscode";
import type { ResolvedReference } from "../references/sourceTypes.js";

export type DecorationKind = "matched" | "heuristic" | "unresolved";

export interface DisposableLike {
  dispose(): void;
}

export interface DecorationTypeLike extends DisposableLike {}

export interface DecorationEditorLike {
  readonly document: {
    readonly uri: { toString(): string };
  };
  setDecorations(
    decorationType: DecorationTypeLike,
    ranges: readonly unknown[],
  ): void;
}

export interface DecorationHost {
  createDecorationType(
    options: vscode.DecorationRenderOptions,
  ): DecorationTypeLike;
  createRange(
    startLine: number,
    startColumn: number,
    endLine: number,
    endColumn: number,
  ): unknown;
  getVisibleEditors(): readonly DecorationEditorLike[];
  onDidChangeVisibleEditors(
    listener: (editors: readonly DecorationEditorLike[]) => void,
  ): DisposableLike;
}

export const DECORATION_STYLES: Readonly<
  Record<DecorationKind, vscode.DecorationRenderOptions>
> = {
  matched: {
    backgroundColor: "rgba(46, 160, 67, 0.12)",
    borderColor: "rgba(46, 160, 67, 0.55)",
    borderStyle: "solid",
    borderWidth: "0 0 0 2px",
    overviewRulerColor: "rgba(46, 160, 67, 0.75)",
    overviewRulerLane: 4,
  },
  heuristic: {
    backgroundColor: "rgba(210, 153, 34, 0.14)",
    borderColor: "rgba(210, 153, 34, 0.65)",
    borderStyle: "solid",
    borderWidth: "0 0 0 2px",
    overviewRulerColor: "rgba(210, 153, 34, 0.85)",
    overviewRulerLane: 4,
  },
  unresolved: {
    opacity: "0.45",
    overviewRulerColor: "rgba(128, 128, 128, 0.75)",
    overviewRulerLane: 4,
  },
};

const DECORATION_KINDS: readonly DecorationKind[] = [
  "matched",
  "heuristic",
  "unresolved",
];

export class ReferenceDecorationManager implements DisposableLike {
  private readonly decorationTypes = new Map<
    DecorationKind,
    DecorationTypeLike
  >();
  private readonly visibleEditorsSubscription: DisposableLike;
  private latestReferences: readonly ResolvedReference[] = [];

  public constructor(private readonly host: DecorationHost) {
    for (const kind of DECORATION_KINDS) {
      this.decorationTypes.set(
        kind,
        host.createDecorationType(DECORATION_STYLES[kind]),
      );
    }
    this.visibleEditorsSubscription = host.onDidChangeVisibleEditors(
      (editors) => this.apply(editors),
    );
  }

  public update(references: readonly ResolvedReference[]): void {
    this.latestReferences = [...references];
    this.apply(this.host.getVisibleEditors());
  }

  public dispose(): void {
    this.visibleEditorsSubscription.dispose();
    for (const decorationType of this.decorationTypes.values()) {
      decorationType.dispose();
    }
    this.decorationTypes.clear();
    this.latestReferences = [];
  }

  private apply(editors: readonly DecorationEditorLike[]): void {
    for (const editor of editors) {
      const editorUri = editor.document.uri.toString();
      for (const kind of DECORATION_KINDS) {
        const decorationType = this.decorationTypes.get(kind);
        if (!decorationType) {
          continue;
        }
        const ranges = this.latestReferences
          .filter(
            (reference) =>
              reference.workspaceUri?.toString() === editorUri &&
              decorationKind(reference) === kind,
          )
          .map((reference) =>
            referenceDecorationRange(reference, (...coordinates) =>
              this.host.createRange(...coordinates),
            ),
          );
        editor.setDecorations(decorationType, ranges);
      }
    }
  }
}

export function decorationKind(reference: ResolvedReference): DecorationKind {
  if (
    reference.status === "external" ||
    reference.status === "unmapped" ||
    reference.status === "error"
  ) {
    return "unresolved";
  }
  if (reference.confidence === "heuristic") {
    return "heuristic";
  }
  return reference.workspaceUri ? "matched" : "unresolved";
}

export function referenceDecorationRange<T>(
  reference: ResolvedReference,
  createRange: (
    startLine: number,
    startColumn: number,
    endLine: number,
    endColumn: number,
  ) => T,
): T | vscode.Range {
  if (reference.resolvedRange) {
    return reference.resolvedRange;
  }

  const startLine = reference.source.line - 1;
  const startColumn = reference.source.column - 1;
  const endLine = (reference.source.endLine ?? reference.source.line) - 1;
  const endColumn = reference.source.endColumn
    ? reference.source.endColumn - 1
    : startColumn + 1;
  return createRange(startLine, startColumn, endLine, endColumn);
}
