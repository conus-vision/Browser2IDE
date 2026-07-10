import { describe, expect, it } from "vitest";
import { adaptSourceDocument } from "../src/sourcePlugins/sourceDocument.js";

describe("adaptSourceDocument", () => {
  it("adapts a VS Code text document without exposing vscode types", () => {
    const text = ".card {}";
    const adapted = adaptSourceDocument({
      uri: { toString: () => "file:///workspace/src/card.scss" },
      languageId: "scss",
      version: 7,
      getText: () => text,
      positionAt: (offset) => ({ line: 0, character: offset }),
      offsetAt: (position) => position.character,
    });

    expect(adapted).toMatchObject({
      uri: "file:///workspace/src/card.scss",
      languageId: "scss",
      version: 7,
    });
    expect(adapted.getText()).toBe(text);
    expect(adapted.positionAt(6)).toEqual({ line: 0, character: 6 });
    expect(adapted.offsetAt({ line: 0, character: 5 })).toBe(5);
  });
});
