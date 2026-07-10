import type { ResolvedReference } from "../references/sourceTypes.js";
import type { DisposableLike } from "./decorations.js";

export interface PresenterCommandHost {
  registerCommand(
    command: string,
    callback: (...arguments_: unknown[]) => unknown,
  ): DisposableLike;
}

export interface ReferenceLookup {
  getReference(referenceId: string): ResolvedReference | undefined;
}

export interface SingleReferenceNavigator {
  openReference(reference: ResolvedReference): Promise<void>;
}

export function registerPresenterCommands(
  host: PresenterCommandHost,
  references: ReferenceLookup,
  navigator: SingleReferenceNavigator,
  reportError: (error: unknown) => void,
): DisposableLike {
  return host.registerCommand(
    "browser2ide.openReference",
    async (referenceId: unknown) => {
      if (typeof referenceId !== "string") {
        return;
      }
      const reference = references.getReference(referenceId);
      if (!reference) {
        return;
      }
      try {
        await navigator.openReference(reference);
      } catch (error) {
        reportError(error);
      }
    },
  );
}
