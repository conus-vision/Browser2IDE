import { describe, expect, it } from "vitest";
import { registerPresenterCommands } from "../src/presenter/commands.js";
import type { ResolvedReference } from "../src/references/sourceTypes.js";

describe("presenter commands", () => {
  it("opens the current tree reference and reports navigation errors", async () => {
    const callbacks = new Map<string, (...arguments_: unknown[]) => unknown>();
    const current = reference();
    const opened: ResolvedReference[] = [];
    const errors: unknown[] = [];
    let disposed = false;
    const disposable = registerPresenterCommands(
      {
        registerCommand(command, callback) {
          callbacks.set(command, callback);
          return { dispose: () => (disposed = true) };
        },
      },
      { getReference: (id) => (id === "current" ? current : undefined) },
      {
        async openReference(candidate) {
          opened.push(candidate);
          if (opened.length === 2) {
            throw new Error("navigation failed");
          }
        },
      },
      (error) => errors.push(error),
    );

    const callback = callbacks.get("browser2ide.openReference");
    expect(callback).toBeTypeOf("function");
    await callback?.("missing");
    await callback?.("current");
    await callback?.("current");

    expect(opened).toEqual([current, current]);
    expect(errors).toHaveLength(1);
    disposable.dispose();
    expect(disposed).toBe(true);
  });
});

function reference(): ResolvedReference {
  return {
    kind: "style-rule",
    relation: "styles",
    label: ".card",
    source: {
      uri: "file:///workspace/card.scss",
      line: 1,
      column: 1,
      metadata: {},
    },
    confidence: "sourcemap",
    status: "matched",
    metadata: {},
    diagnostics: [],
  };
}
