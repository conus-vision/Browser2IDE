import type {
  Disposable,
  SelectionSnapshot,
  SourceDocument,
  SourceWorkspace,
} from "@browser2ide/plugin-api";
import type { InspectMessage } from "@browser2ide/protocol";
import {
  adaptSourceDocument,
  type TextDocumentLike,
} from "../sourcePlugins/sourceDocument.js";
import type { SourceResolution } from "../sourcePlugins/types.js";
import type { SelectionStore } from "./selectionStore.js";

export interface ActiveEditorLike {
  readonly document: TextDocumentLike;
}

export interface CoordinatorHost {
  getActiveEditor(): ActiveEditorLike | undefined;
  onDidChangeActiveEditor(
    listener: (editor: ActiveEditorLike | undefined) => void,
  ): Disposable;
  onDidChangeTextDocument(
    listener: (document: TextDocumentLike) => void,
  ): Disposable;
}

export interface SourcePluginRegistryLike {
  resolve(
    selection: SelectionSnapshot,
    document: SourceDocument,
    workspace: SourceWorkspace,
    signal: AbortSignal,
  ): Promise<SourceResolution>;
  onDidChange(listener: () => void): Disposable;
}

export interface ActiveEditorCoordinatorOptions {
  readonly host: CoordinatorHost;
  readonly registry: SourcePluginRegistryLike;
  readonly workspace: SourceWorkspace;
  readonly store: SelectionStore;
  readonly publish: (
    editor: ActiveEditorLike,
    resolution: SourceResolution,
  ) => void;
  readonly clear: () => void;
  readonly onError?: (error: unknown) => void;
  readonly editDebounceMs?: number;
}

export class ActiveEditorCoordinator implements Disposable {
  private readonly subscriptions: Disposable[];
  private readonly editDebounceMs: number;
  private generation = 0;
  private abort: AbortController | undefined;
  private editTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  public constructor(
    private readonly options: ActiveEditorCoordinatorOptions,
  ) {
    this.editDebounceMs = options.editDebounceMs ?? 150;
    this.subscriptions = [
      options.host.onDidChangeActiveEditor(() => this.resolveImmediately()),
      options.host.onDidChangeTextDocument((document) =>
        this.handleDocumentChange(document),
      ),
      options.registry.onDidChange(() => this.resolveImmediately()),
    ];
  }

  public select(message: InspectMessage): void {
    if (this.disposed) return;
    this.options.store.replace(message);
    this.resolveImmediately();
  }

  public clearSelection(): void {
    if (this.disposed) return;
    this.options.store.clear();
    this.resolveImmediately();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearEditTimer();
    this.abort?.abort();
    this.abort = undefined;
    this.generation += 1;
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  private handleDocumentChange(document: TextDocumentLike): void {
    if (this.disposed) return;
    const active = this.options.host.getActiveEditor();
    if (!active || active.document.uri.toString() !== document.uri.toString()) {
      return;
    }
    this.clearEditTimer();
    this.editTimer = setTimeout(() => {
      this.editTimer = undefined;
      void this.resolveCurrent();
    }, this.editDebounceMs);
  }

  private resolveImmediately(): void {
    this.clearEditTimer();
    void this.resolveCurrent();
  }

  private async resolveCurrent(): Promise<void> {
    if (this.disposed) return;
    const selection = this.options.store.current();
    const editor = this.options.host.getActiveEditor();
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    const generation = ++this.generation;
    if (!selection || !editor) {
      this.options.clear();
      return;
    }

    const document = adaptSourceDocument(editor.document);
    try {
      const result = await this.options.registry.resolve(
        selection,
        document,
        this.options.workspace,
        abort.signal,
      );
      if (
        abort.signal.aborted ||
        generation !== this.generation ||
        this.disposed
      ) {
        return;
      }
      this.options.publish(editor, result);
    } catch (error) {
      if (
        abort.signal.aborted ||
        generation !== this.generation ||
        this.disposed
      ) {
        return;
      }
      this.options.clear();
      this.options.onError?.(error);
    }
  }

  private clearEditTimer(): void {
    if (this.editTimer === undefined) return;
    clearTimeout(this.editTimer);
    this.editTimer = undefined;
  }
}
