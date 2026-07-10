import type * as vscode from "vscode";
import type {
  Browser2IDEApi,
  Disposable,
  SourcePosition,
  SourceRange,
  SourceWorkspace,
} from "@browser2ide/plugin-api";
import type { InspectMessage } from "@browser2ide/protocol";
import type { DiagnosticsTracker } from "../diagnostics.js";
import { createBrowser2IDEApi } from "../sourcePlugins/api.js";
import { CssSourcePlugin } from "../sourcePlugins/cssSourcePlugin.js";
import { SourcePluginRegistry } from "../sourcePlugins/registry.js";
import { ScssSourcePlugin } from "../sourcePlugins/scssSourcePlugin.js";
import {
  VsCodeSourceWorkspace,
  type WorkspaceHost,
} from "../sourcePlugins/sourceWorkspace.js";
import type { SourceResolution } from "../sourcePlugins/types.js";
import {
  ActiveEditorCoordinator,
  type ActiveEditorLike,
  type CoordinatorHost,
} from "./activeEditorCoordinator.js";
import {
  ApplicableSourcesTreeDataProvider,
  type ApplicableSourcesTreeOptions,
} from "./applicableSourcesTree.js";
import { registerPresenterCommands } from "./commands.js";
import {
  SourceDecorationManager,
  type DecorationRole,
  type DisposableLike,
  type SourceDecorationEditorLike,
  type SourceDecorationHost,
} from "./decorations.js";
import { SelectionStore } from "./selectionStore.js";

export type PresenterEditorLike = ActiveEditorLike & SourceDecorationEditorLike;

export interface PresenterRuntimeHost
  extends CoordinatorHost,
    WorkspaceHost,
    SourceDecorationHost {
  getActiveEditor(): PresenterEditorLike | undefined;
  createThemeIcon(id: string): vscode.ThemeIcon;
  registerTreeDataProvider(
    provider: ApplicableSourcesTreeDataProvider,
  ): DisposableLike;
  registerCommand(
    command: string,
    callback: (...arguments_: unknown[]) => unknown,
  ): DisposableLike;
  revealRange(editor: PresenterEditorLike, range: unknown): void;
  selectRangeStart(editor: PresenterEditorLike, start: SourcePosition): void;
  reportError(error: unknown): void;
}

export interface PresenterRuntimeOptions {
  readonly host: PresenterRuntimeHost;
  readonly registry?: SourcePluginRegistry;
  readonly workspace?: SourceWorkspace;
  readonly diagnostics?: Pick<DiagnosticsTracker, "recordResolution">;
}

export interface PresenterRuntime extends DisposableLike {
  readonly api: Browser2IDEApi;
  readonly tree: ApplicableSourcesTreeDataProvider;
  select(message: InspectMessage): void;
  clear(): void;
}

export function createPresenterRuntime(
  options: PresenterRuntimeOptions,
): PresenterRuntime {
  const { host } = options;
  const registry = options.registry ?? new SourcePluginRegistry();
  const api = createBrowser2IDEApi(registry);
  const builtIns: Disposable[] = [
    registry.register(new CssSourcePlugin()),
    registry.register(new ScssSourcePlugin()),
  ];
  const workspace = options.workspace ?? new VsCodeSourceWorkspace(host);
  const treeOptions: ApplicableSourcesTreeOptions = {
    createThemeIcon: (id) => host.createThemeIcon(id),
  };
  const tree = new ApplicableSourcesTreeDataProvider(treeOptions);
  const decorations = new SourceDecorationManager(host);
  const treeRegistration = host.registerTreeDataProvider(tree);
  const commandRegistration = registerPresenterCommands(
    {
      registerCommand: (command, callback) =>
        host.registerCommand(command, callback),
      getActiveEditor: () => host.getActiveEditor(),
      createRange: (range: SourceRange) => createHostRange(host, range),
      revealRange: (editor, range) =>
        host.revealRange(editor as PresenterEditorLike, range),
      selectRangeStart: (editor, start) =>
        host.selectRangeStart(editor as PresenterEditorLike, start),
    },
    tree,
    (error) => host.reportError(error),
  );
  const store = new SelectionStore();
  const publish = (
    editor: ActiveEditorLike,
    resolution: SourceResolution,
  ): void => {
    tree.update(resolution);
    decorations.update(editor as PresenterEditorLike, resolution);
    options.diagnostics?.recordResolution(resolution);
  };
  const clear = (): void => {
    tree.clear();
    decorations.clear();
  };
  const coordinator = new ActiveEditorCoordinator({
    host,
    registry,
    workspace,
    store,
    publish,
    clear,
    onError: (error) => host.reportError(error),
  });
  let disposed = false;

  return {
    api,
    tree,
    select(message) {
      coordinator.select(message);
    },
    clear() {
      coordinator.clearSelection();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      coordinator.dispose();
      commandRegistration.dispose();
      treeRegistration.dispose();
      decorations.dispose();
      tree.dispose();
      for (const registration of [...builtIns].reverse()) {
        registration.dispose();
      }
    },
  };
}

function createHostRange(
  host: PresenterRuntimeHost,
  range: SourceRange,
): unknown {
  return host.createRange(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}

export type { DecorationRole };
