import type * as vscode from "vscode";
import { ReferenceStore } from "../references/referenceStore.js";
import type { ResolveInput, ResolvedReference } from "../references/sourceTypes.js";
import {
  ApplicableRulesTreeDataProvider,
  type ApplicableRulesTreeOptions,
} from "./applicableRulesTree.js";
import { registerPresenterCommands } from "./commands.js";
import {
  ReferenceDecorationManager,
  type DecorationHost,
  type DisposableLike,
} from "./decorations.js";
import {
  InspectPresenter,
  ReferenceNavigator,
  type ReferenceNavigationHost,
} from "./openReferences.js";

export interface PresenterRuntimeHost
  extends DecorationHost,
    ReferenceNavigationHost {
  createThemeIcon(id: string): vscode.ThemeIcon;
  registerTreeDataProvider(
    provider: ApplicableRulesTreeDataProvider,
  ): DisposableLike;
  registerCommand(
    command: string,
    callback: (...arguments_: unknown[]) => unknown,
  ): DisposableLike;
  reportError(error: unknown): void;
}

export interface PresenterRuntimeOptions {
  readonly resolver: {
    resolve(input: ResolveInput): Promise<ResolvedReference[]>;
  };
  readonly host: PresenterRuntimeHost;
}

export interface PresenterRuntime extends DisposableLike {
  readonly presenter: InspectPresenter;
  readonly tree: ApplicableRulesTreeDataProvider;
}

export function createPresenterRuntime(
  options: PresenterRuntimeOptions,
): PresenterRuntime {
  const { host } = options;
  const treeOptions: ApplicableRulesTreeOptions = {
    createThemeIcon: (id) => host.createThemeIcon(id),
  };
  const tree = new ApplicableRulesTreeDataProvider(treeOptions);
  const decorations = new ReferenceDecorationManager(host);
  const navigator = new ReferenceNavigator(host);
  const presenter = new InspectPresenter({
    resolver: options.resolver,
    store: new ReferenceStore(),
    tree,
    decorations,
    navigator,
  });
  const treeRegistration = host.registerTreeDataProvider(tree);
  const commandRegistration = registerPresenterCommands(
    host,
    tree,
    navigator,
    (error) => host.reportError(error),
  );
  let disposed = false;

  return {
    presenter,
    tree,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      presenter.cancel();
      treeRegistration.dispose();
      commandRegistration.dispose();
      decorations.dispose();
      tree.dispose();
    },
  };
}
