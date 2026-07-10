import type { InspectMessage } from "@browser2ide/protocol";
import type * as vscode from "vscode";
import type {
  ReferenceSnapshot,
  ReferenceStore,
} from "../references/referenceStore.js";
import type { ResolveInput } from "../references/sourceTypes.js";
import type { ResolvedReference } from "../references/sourceTypes.js";
import { referenceDecorationRange } from "./decorations.js";

export interface NavigationDocumentLike {
  readonly uri: { toString(): string };
}

export interface NavigationEditorLike {}

export interface ReferenceNavigationHost {
  openTextDocument(uri: vscode.Uri): PromiseLike<NavigationDocumentLike>;
  showTextDocument(
    document: NavigationDocumentLike,
    options: { preview: false; preserveFocus: boolean },
  ): PromiseLike<NavigationEditorLike>;
  createRange(
    startLine: number,
    startColumn: number,
    endLine: number,
    endColumn: number,
  ): unknown;
  revealRange(editor: NavigationEditorLike, range: unknown): void;
}

const CONFIDENCE_PRIORITY: Record<ResolvedReference["confidence"], number> = {
  exact: 0,
  sourcemap: 1,
  instrumented: 2,
  heuristic: 3,
  unknown: 4,
};

const STATUS_PRIORITY: Record<ResolvedReference["status"], number> = {
  active: 0,
  matched: 1,
  overridden: 2,
  external: 3,
  unmapped: 4,
  error: 5,
};

export class ReferenceNavigator {
  public constructor(private readonly host: ReferenceNavigationHost) {}

  public async openReferences(
    references: readonly ResolvedReference[],
    openAll: boolean,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    const localReferences = localReferencesByPriority(references);
    const selected = openAll
      ? uniqueReferencesByUri(localReferences)
      : localReferences.slice(0, 1);
    for (const [index, reference] of selected.entries()) {
      if (!isCurrent()) {
        return;
      }
      await this.openLocalReference(reference, index > 0, isCurrent);
    }
  }

  public async openReference(reference: ResolvedReference): Promise<void> {
    await this.openLocalReference(reference, false, () => true);
  }

  private async openLocalReference(
    reference: ResolvedReference,
    preserveFocus: boolean,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!reference.workspaceUri) {
      return;
    }
    const document = await this.host.openTextDocument(reference.workspaceUri);
    if (!isCurrent()) {
      return;
    }
    const editor = await this.host.showTextDocument(document, {
      preview: false,
      preserveFocus,
    });
    if (!isCurrent()) {
      return;
    }
    const range = referenceDecorationRange(reference, (...coordinates) =>
      this.host.createRange(...coordinates),
    );
    this.host.revealRange(editor, range);
  }
}

export interface InspectPresenterOptions {
  readonly resolver: {
    resolve(input: ResolveInput): Promise<ResolvedReference[]>;
  };
  readonly store: Pick<ReferenceStore, "replace">;
  readonly tree: {
    update(snapshot: ReferenceSnapshot): void;
  };
  readonly decorations: {
    update(references: readonly ResolvedReference[]): void;
  };
  readonly navigator: {
    openReferences(
      references: readonly ResolvedReference[],
      openAll: boolean,
      isCurrent?: () => boolean,
    ): Promise<void>;
  };
}

export class InspectPresenter {
  private generation = 0;

  public constructor(private readonly options: InspectPresenterOptions) {}

  public async present(
    message: InspectMessage,
    openAll: boolean,
  ): Promise<boolean> {
    const generation = ++this.generation;
    const isCurrent = () => generation === this.generation;
    let references: ResolvedReference[];
    try {
      references = await this.options.resolver.resolve({
        message,
        facts: message.facts,
      });
    } catch (error) {
      if (!isCurrent()) {
        return false;
      }
      throw error;
    }
    if (!isCurrent()) {
      return false;
    }

    const snapshot = this.options.store.replace(
      message.sessionId,
      message.messageId,
      references,
    );
    this.options.tree.update(snapshot);
    this.options.decorations.update(snapshot.references);
    try {
      await this.options.navigator.openReferences(
        snapshot.references,
        openAll,
        isCurrent,
      );
    } catch (error) {
      if (!isCurrent()) {
        return false;
      }
      throw error;
    }
    return isCurrent();
  }

  public cancel(): void {
    this.generation += 1;
  }
}

function uniqueReferencesByUri(
  references: readonly (ResolvedReference & { workspaceUri: vscode.Uri })[],
): Array<ResolvedReference & { workspaceUri: vscode.Uri }> {
  const unique = new Map<
    string,
    ResolvedReference & { workspaceUri: vscode.Uri }
  >();
  for (const reference of references) {
    const key = reference.workspaceUri.toString();
    if (!unique.has(key)) {
      unique.set(key, reference);
    }
  }
  return [...unique.values()];
}

function localReferencesByPriority(
  references: readonly ResolvedReference[],
): Array<ResolvedReference & { workspaceUri: vscode.Uri }> {
  return references
    .filter(
      (reference): reference is ResolvedReference & { workspaceUri: vscode.Uri } =>
        reference.workspaceUri !== undefined,
    )
    .sort(
      (left, right) =>
        CONFIDENCE_PRIORITY[left.confidence] -
          CONFIDENCE_PRIORITY[right.confidence] ||
        STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status] ||
        left.workspaceUri.toString().localeCompare(right.workspaceUri.toString()) ||
        left.source.line - right.source.line,
    );
}
