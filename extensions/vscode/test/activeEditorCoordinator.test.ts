import { describe, expect, it, vi } from "vitest";
import type {
  Disposable,
  SelectionSnapshot,
  SourceDocument,
  SourceWorkspace,
} from "@browser2ide/plugin-api";
import {
  PROTOCOL_VERSION,
  type InspectMessage,
} from "@browser2ide/protocol";
import {
  ActiveEditorCoordinator,
  type ActiveEditorLike,
  type CoordinatorHost,
  type SourcePluginRegistryLike,
} from "../src/presenter/activeEditorCoordinator.js";
import { SelectionStore } from "../src/presenter/selectionStore.js";
import type { SourceResolution } from "../src/sourcePlugins/types.js";

describe("ActiveEditorCoordinator", () => {
  it("retains selection and resolves it against each active editor", async () => {
    const harness = coordinatorHarness();
    harness.coordinator.select(inspectMessage("inspect-1"));
    await harness.flush();
    harness.changeActiveEditor(editor("file:///src/card.scss", "scss", 1));
    await harness.flush();

    expect(harness.resolveCalls.map((call) => call.document.languageId)).toEqual([
      "css",
      "scss",
    ]);
    expect(harness.openDocumentCalls).toBe(0);
  });

  it("debounces active document changes by 150ms", async () => {
    vi.useFakeTimers();
    try {
      const harness = coordinatorHarness();
      harness.coordinator.select(inspectMessage("inspect-1"));
      await harness.flush();
      harness.changeDocumentVersion(2);
      harness.changeDocumentVersion(3);
      await vi.advanceTimersByTimeAsync(149);
      expect(harness.resolveCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.resolveCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts and ignores a stale resolution", async () => {
    const harness = deferredCoordinatorHarness();
    harness.coordinator.select(inspectMessage("old"));
    harness.coordinator.select(inspectMessage("new"));
    expect(harness.signals.get("old")?.aborted).toBe(true);
    harness.resolve("old", resolution("old"));
    harness.resolve("new", resolution("new"));
    await harness.flush();

    expect(harness.published.map((entry) => entry.selectionMessageId)).toEqual([
      "new",
    ]);
  });

  it("clears and aborts immediately before a replacement selection settles", async () => {
    const harness = deferredCoordinatorHarness();
    harness.coordinator.select(inspectMessage("old"));
    harness.resolve("old", resolution("old"));
    await harness.flush();
    const clearCalls = harness.clearCalls;

    harness.coordinator.select(inspectMessage("new"));

    expect(harness.signals.get("old")?.aborted).toBe(true);
    expect(harness.clearCalls).toBe(clearCalls + 1);
    expect(harness.published.map((entry) => entry.selectionMessageId)).toEqual([
      "old",
    ]);

    harness.resolve("new", resolution("new"));
    await harness.flush();
    expect(harness.published.map((entry) => entry.selectionMessageId)).toEqual([
      "old",
      "new",
    ]);
  });

  it("invalidates immediately while debouncing active document resolution", async () => {
    vi.useFakeTimers();
    try {
      const harness = deferredCoordinatorHarness();
      harness.coordinator.select(inspectMessage("inspect-1"));
      const clearCalls = harness.clearCalls;

      harness.changeDocumentVersion(2);

      expect(harness.clearCalls).toBe(clearCalls + 1);
      expect(harness.signals.get("inspect-1")?.aborted).toBe(true);
      expect(harness.resolveCalls).toHaveLength(1);

      harness.resolve(
        "inspect-1",
        resolution("inspect-1", harness.resolveCalls[0]!.document),
      );
      await harness.flush();
      expect(harness.published).toEqual([]);

      await vi.advanceTimersByTimeAsync(149);
      expect(harness.resolveCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.resolveCalls.map((call) => call.document.version)).toEqual([
        1,
        2,
      ]);
      expect(harness.published).toEqual([]);

      harness.resolve(
        "inspect-1",
        resolution("inspect-1", harness.resolveCalls[1]!.document),
      );
      await harness.flush();
      expect(harness.published.map((entry) => entry.documentVersion)).toEqual([
        2,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears on selection, editor, plugin, and explicit-clear triggers", async () => {
    const harness = coordinatorHarness();
    harness.coordinator.select(inspectMessage("inspect-1"));
    expect(harness.clearCalls).toBe(1);
    await harness.flush();
    harness.changeActiveEditor(undefined);
    expect(harness.clearCalls).toBe(2);
    await harness.flush();
    harness.changeActiveEditor(editor("file:///src/app.css", "css", 1));
    expect(harness.clearCalls).toBe(3);
    harness.emitPluginChange();
    expect(harness.clearCalls).toBe(4);
    await harness.flush();
    harness.coordinator.clearSelection();
    expect(harness.clearCalls).toBe(5);
    await harness.flush();

    expect(harness.resolveCalls).toHaveLength(3);
  });

  it("disposes subscriptions, timers, and pending work", async () => {
    vi.useFakeTimers();
    try {
      const harness = coordinatorHarness();
      harness.coordinator.select(inspectMessage("inspect-1"));
      await harness.flush();
      harness.changeDocumentVersion(2);
      harness.coordinator.dispose();
      await vi.advanceTimersByTimeAsync(150);
      harness.emitPluginChange();

      expect(harness.resolveCalls).toHaveLength(1);
      expect(harness.disposals()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

function coordinatorHarness() {
  let activeEditor: ActiveEditorLike | undefined = editor(
    "file:///src/app.css",
    "css",
    1,
  );
  const activeListeners = new Set<(editor: ActiveEditorLike | undefined) => void>();
  const documentListeners = new Set<(document: SourceDocumentLike) => void>();
  const pluginListeners = new Set<() => void>();
  const resolveCalls: Array<{
    selection: SelectionSnapshot;
    document: SourceDocument;
    signal: AbortSignal;
  }> = [];
  const published: SourceResolution[] = [];
  let clearCalls = 0;
  let openDocumentCalls = 0;
  let disposed = 0;
  const host: CoordinatorHost = {
    getActiveEditor: () => activeEditor,
    onDidChangeActiveEditor(listener) {
      activeListeners.add(listener);
      return disposable(() => {
        activeListeners.delete(listener);
        disposed += 1;
      });
    },
    onDidChangeTextDocument(listener) {
      documentListeners.add(listener);
      return disposable(() => {
        documentListeners.delete(listener);
        disposed += 1;
      });
    },
  };
  const registry: SourcePluginRegistryLike = {
    onDidChange(listener) {
      pluginListeners.add(listener);
      return disposable(() => {
        pluginListeners.delete(listener);
        disposed += 1;
      });
    },
    async resolve(selection, document, _workspace, signal) {
      resolveCalls.push({ selection, document, signal });
      return resolution(selection.messageId, document);
    },
  };
  const coordinator = new ActiveEditorCoordinator({
    host,
    registry,
    workspace: workspace(),
    store: new SelectionStore(),
    publish: (_editor, result) => published.push(result),
    clear: () => {
      clearCalls += 1;
    },
  });

  return {
    coordinator,
    resolveCalls,
    published,
    get clearCalls() {
      return clearCalls;
    },
    get openDocumentCalls() {
      return openDocumentCalls;
    },
    changeActiveEditor(next: ActiveEditorLike | undefined) {
      activeEditor = next;
      for (const listener of activeListeners) listener(next);
    },
    changeDocumentVersion(version: number) {
      if (!activeEditor) return;
      activeEditor = editor(
        activeEditor.document.uri.toString(),
        activeEditor.document.languageId,
        version,
      );
      for (const listener of documentListeners) {
        listener(activeEditor.document);
      }
    },
    emitPluginChange() {
      for (const listener of pluginListeners) listener();
    },
    disposals: () => disposed,
    flush,
  };
}

function deferredCoordinatorHarness() {
  let activeEditor: ActiveEditorLike | undefined = editor(
    "file:///src/app.css",
    "css",
    1,
  );
  const documentListeners = new Set<(document: SourceDocumentLike) => void>();
  const pending = new Map<
    string,
    (resolution: SourceResolution) => void
  >();
  const signals = new Map<string, AbortSignal>();
  const resolveCalls: Array<{
    selection: SelectionSnapshot;
    document: SourceDocument;
    signal: AbortSignal;
  }> = [];
  const published: SourceResolution[] = [];
  let clearCalls = 0;
  const registry: SourcePluginRegistryLike = {
    onDidChange: () => disposable(() => undefined),
    resolve(selection, document, _workspace, signal) {
      signals.set(selection.messageId, signal);
      resolveCalls.push({ selection, document, signal });
      return new Promise((resolve) => pending.set(selection.messageId, resolve));
    },
  };
  const coordinator = new ActiveEditorCoordinator({
    host: {
      getActiveEditor: () => activeEditor,
      onDidChangeActiveEditor: () => disposable(() => undefined),
      onDidChangeTextDocument(listener) {
        documentListeners.add(listener);
        return disposable(() => documentListeners.delete(listener));
      },
    },
    registry,
    workspace: workspace(),
    store: new SelectionStore(),
    publish: (_editor, result) => published.push(result),
    clear: () => {
      clearCalls += 1;
    },
  });
  return {
    coordinator,
    published,
    signals,
    resolveCalls,
    get clearCalls() {
      return clearCalls;
    },
    changeDocumentVersion(version: number) {
      if (!activeEditor) return;
      activeEditor = editor(
        activeEditor.document.uri.toString(),
        activeEditor.document.languageId,
        version,
      );
      for (const listener of documentListeners) {
        listener(activeEditor.document);
      }
    },
    resolve(messageId: string, result: SourceResolution) {
      pending.get(messageId)?.(result);
    },
    flush,
  };
}

interface SourceDocumentLike {
  readonly uri: { toString(): string };
  readonly languageId: string;
  readonly version: number;
  getText(): string;
  positionAt(offset: number): { line: number; character: number };
  offsetAt(position: { line: number; character: number }): number;
}

function editor(
  uri: string,
  languageId: string,
  version: number,
): ActiveEditorLike {
  return {
    document: {
      uri: { toString: () => uri },
      languageId,
      version,
      getText: () => ".card {}",
      positionAt: (offset) => ({ line: 0, character: offset }),
      offsetAt: (position) => position.character,
    },
  };
}

function resolution(
  selectionMessageId: string,
  document: SourceDocument = {
    uri: "file:///src/app.css",
    languageId: "css",
    version: 1,
    getText: () => "",
    positionAt: () => ({ line: 0, character: 0 }),
    offsetAt: () => 0,
  },
): SourceResolution {
  return {
    selectionMessageId,
    documentUri: document.uri,
    documentVersion: document.version,
    matches: [],
    diagnostics: [],
  };
}

function inspectMessage(messageId: string): InspectMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "inspect",
    messageId,
    sessionId: "session-1",
    source: { role: "browser", id: "firefox", metadata: {} },
    targets: [
      {
        role: "selected",
        depth: 0,
        subject: { selector: ".card", metadata: {} },
        facts: [
          {
            type: "css-rule",
            selector: ".card",
            property: "color",
            value: "red",
            metadata: { sourceUrl: "/dist/app.css" },
          },
        ],
        metadata: {},
      },
    ],
    context: { url: "http://localhost:4173/", metadata: {} },
    metadata: {},
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

function disposable(dispose: () => void): Disposable {
  return { dispose };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
