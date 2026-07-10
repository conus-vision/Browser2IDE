import type { SourcePosition, SourceRange } from "@browser2ide/plugin-api";
import type { ResolvedReference } from "../references/sourceTypes.js";
import type { ResolvedSourceMatch } from "../sourcePlugins/types.js";
import type { DisposableLike } from "./decorations.js";

export interface RevealEditorLike {
  readonly document: { readonly uri: { toString(): string } };
}

export interface PresenterCommandHost {
  registerCommand(
    command: string,
    callback: (...arguments_: unknown[]) => unknown,
  ): DisposableLike;
  getActiveEditor(): RevealEditorLike | undefined;
  createRange(range: SourceRange): unknown;
  revealRange(editor: RevealEditorLike, range: unknown): void;
  selectRangeStart(editor: RevealEditorLike, start: SourcePosition): void;
}

export interface SourceMatchLookup {
  getMatch(sourceMatchId: string): ResolvedSourceMatch | undefined;
  getDocumentUri(): string | undefined;
}

interface LegacyPresenterCommandHost {
  registerCommand(
    command: string,
    callback: (...arguments_: unknown[]) => unknown,
  ): DisposableLike;
}

interface LegacyReferenceLookup {
  getReference(referenceId: string): ResolvedReference | undefined;
}

interface LegacyNavigator {
  openReference(reference: ResolvedReference): Promise<void>;
}

export function registerPresenterCommands(
  host: PresenterCommandHost,
  matches: SourceMatchLookup,
  reportError: (error: unknown) => void,
): DisposableLike;
export function registerPresenterCommands(
  host: LegacyPresenterCommandHost,
  references: LegacyReferenceLookup,
  navigator: LegacyNavigator,
  reportError: (error: unknown) => void,
): DisposableLike;
export function registerPresenterCommands(
  host: PresenterCommandHost | LegacyPresenterCommandHost,
  lookup: SourceMatchLookup | LegacyReferenceLookup,
  third: ((error: unknown) => void) | LegacyNavigator,
  fourth?: (error: unknown) => void,
): DisposableLike {
  if (fourth) {
    return registerLegacyCommand(
      host,
      lookup as LegacyReferenceLookup,
      third as LegacyNavigator,
      fourth,
    );
  }

  const sourceHost = host as PresenterCommandHost;
  const matches = lookup as SourceMatchLookup;
  const reportError = third as (error: unknown) => void;
  return sourceHost.registerCommand(
    "browser2ide.revealSourceMatch",
    (sourceMatchId: unknown) => {
      if (typeof sourceMatchId !== "string") return;
      const match = matches.getMatch(sourceMatchId);
      if (!match) return;

      const editor = sourceHost.getActiveEditor();
      const documentUri = matches.getDocumentUri();
      if (!editor || !documentUri || editor.document.uri.toString() !== documentUri) {
        reportError(
          new Error("Browser2IDE source match is not in the active editor"),
        );
        return;
      }

      const range = sourceHost.createRange(match.range);
      sourceHost.revealRange(editor, range);
      sourceHost.selectRangeStart(editor, match.range.start);
    },
  );
}

function registerLegacyCommand(
  host: LegacyPresenterCommandHost,
  references: LegacyReferenceLookup,
  navigator: LegacyNavigator,
  reportError: (error: unknown) => void,
): DisposableLike {
  return host.registerCommand(
    "browser2ide.openReference",
    async (referenceId: unknown) => {
      if (typeof referenceId !== "string") return;
      const reference = references.getReference(referenceId);
      if (!reference) return;
      try {
        await navigator.openReference(reference);
      } catch (error) {
        reportError(error);
      }
    },
  );
}
