import { describe, expect, it } from "vitest";
import { registerPresenterCommands } from "../src/presenter/commands.js";
import type { ResolvedSourceMatch } from "../src/sourcePlugins/types.js";

describe("presenter commands", () => {
  it("reveals a current match in the active editor without opening documents", () => {
    const callbacks = new Map<string, (...arguments_: unknown[]) => unknown>();
    const current = match();
    const revealed: unknown[] = [];
    const selected: unknown[] = [];
    const errors: unknown[] = [];
    let activeUri = "file:///src/app.scss";
    let disposed = false;
    const editor = { document: { uri: { toString: () => activeUri } } };
    const registration = registerPresenterCommands(
      {
        registerCommand(command, callback) {
          callbacks.set(command, callback);
          return { dispose: () => (disposed = true) };
        },
        getActiveEditor: () => editor,
        createRange: (range) => range,
        revealRange: (_editor, range) => revealed.push(range),
        selectRangeStart: (_editor, start) => selected.push(start),
      },
      {
        getMatch: (id) => (id === "current" ? current : undefined),
        getDocumentUri: () => "file:///src/app.scss",
      },
      (error) => errors.push(error),
    );

    const callback = callbacks.get("browser2ide.revealSourceMatch");
    expect(callback).toBeTypeOf("function");
    callback?.("missing");
    callback?.("current");
    expect(revealed).toEqual([current.range]);
    expect(selected).toEqual([current.range.start]);

    activeUri = "file:///src/other.scss";
    callback?.("current");
    expect(errors).toHaveLength(1);
    expect(revealed).toHaveLength(1);
    registration.dispose();
    expect(disposed).toBe(true);
  });
});

function match(): ResolvedSourceMatch {
  return {
    pluginId: "browser2ide.scss",
    targetRole: "selected",
    range: {
      start: { line: 1, character: 2 },
      end: { line: 4, character: 1 },
    },
    label: ".card",
    kind: "style-rule",
    relation: "styles",
    confidence: "sourcemap",
  };
}
