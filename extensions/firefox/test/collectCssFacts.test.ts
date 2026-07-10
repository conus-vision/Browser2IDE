import { describe, expect, it } from "vitest";
import { RuntimeFactSchema } from "@browser2ide/protocol";
import { collectCssFacts } from "../src/collectCssFacts.js";

describe("collectCssFacts", () => {
  it("collects matched declarations through nested media rules", () => {
    const result = collectCssFacts(
      {
        matches(selector) {
          if (selector === ":invalid(") {
            throw new Error("invalid selector");
          }
          return selector === ".card";
        },
      },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: "http://localhost:3000/dist/app.css",
            cssRules: [
              {
                media: { conditionText: "(min-width: 40rem)" },
                cssRules: [
                  styleRule(".card", {
                    display: "flex",
                    padding: "1rem !important",
                  }),
                  styleRule(":invalid(", { color: "red" }),
                ],
              },
            ],
          },
        ],
      },
    );

    expect(result.inaccessibleStylesheets).toEqual([]);
    expect(result.facts).toEqual([
      {
        type: "css-rule",
        selector: ".card",
        property: "display",
        value: "flex",
        metadata: {
          sourceUrl: "http://localhost:3000/dist/app.css",
          cssText: ".card { display: flex; padding: 1rem !important; }",
          declarationNames: ["display", "padding"],
          media: ["(min-width: 40rem)"],
          rulePath: "0.0.0",
          priority: "",
        },
      },
      {
        type: "css-rule",
        selector: ".card",
        property: "padding",
        value: "1rem",
        metadata: {
          sourceUrl: "http://localhost:3000/dist/app.css",
          cssText: ".card { display: flex; padding: 1rem !important; }",
          declarationNames: ["display", "padding"],
          media: ["(min-width: 40rem)"],
          rulePath: "0.0.0",
          priority: "important",
        },
      },
    ]);
    for (const fact of result.facts) {
      expect(RuntimeFactSchema.parse(fact)).toEqual(fact);
    }
  });

  it("reports inaccessible stylesheets and marks inline sources", () => {
    const inaccessible = {
      href: "https://cdn.example/vendor.css",
      get cssRules(): never {
        throw new Error("Permission denied");
      },
    };
    const result = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          inaccessible,
          { href: null, cssRules: [styleRule(".local", { color: "red" })] },
        ],
      },
    );

    expect(result.inaccessibleStylesheets).toEqual([
      {
        sourceUrl: "https://cdn.example/vendor.css",
        reason: "Permission denied",
      },
    ]);
    expect(result.facts[0].metadata.sourceUrl).toBe("inline-style://document/1");
  });
});

function styleRule(
  selectorText: string,
  declarations: Record<string, string>,
) {
  const names = Object.keys(declarations);
  return {
    selectorText,
    cssText: `${selectorText} { ${names
      .map((name) => `${name}: ${declarations[name]};`)
      .join(" ")} }`,
    style: {
      length: names.length,
      item: (index: number) => names[index] ?? "",
      getPropertyValue: (name: string) =>
        declarations[name]?.replace(/\s*!important\s*$/, "") ?? "",
      getPropertyPriority: (name: string) =>
        declarations[name]?.endsWith("!important") ? "important" : "",
    },
  };
}
