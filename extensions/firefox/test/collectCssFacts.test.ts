import { describe, expect, it } from "vitest";
import {
  INSPECT_LIMITS,
  RuntimeFactSchema,
} from "@browser2ide/protocol";
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
        code: "browser.stylesheetInaccessible",
        sourceUrl: "https://cdn.example/vendor.css",
        reason: "Permission denied",
      },
    ]);
    expect(result.facts[0].metadata.sourceUrl).toBe("inline-style://document/1");
  });

  it("skips over-limit selectors and properties before reading values", () => {
    let matchCalls = 0;
    let valueReads = 0;
    const oversizedProperty = "p".repeat(
      INSPECT_LIMITS.propertyNameLength + 1,
    );
    const result = collectCssFacts(
      {
        matches() {
          matchCalls += 1;
          return true;
        },
      },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: "/bounded.css",
            cssRules: [
              styleRule(
                "s".repeat(INSPECT_LIMITS.selectorLength + 1),
                { color: "red" },
              ),
              {
                selectorText: ".card",
                cssText: `.card { ${oversizedProperty}: value; }`,
                style: {
                  length: 1,
                  item: () => oversizedProperty,
                  getPropertyValue() {
                    valueReads += 1;
                    return "value";
                  },
                  getPropertyPriority: () => "",
                },
              },
            ],
          },
        ],
      },
    );

    expect(result.facts).toEqual([]);
    expect(matchCalls).toBe(1);
    expect(valueReads).toBe(0);
  });

  it("bounds declaration and priority metadata", () => {
    const declarationCount = INSPECT_LIMITS.declarationsPerRule + 1;
    const result = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: "/metadata.css",
            cssRules: [
              {
                selectorText: ".card",
                cssText: ".card { color: red; }",
                style: {
                  length: declarationCount,
                  item(index: number) {
                    const prefix = `--property-${index}-`;
                    return `${prefix}${"p".repeat(
                      INSPECT_LIMITS.propertyNameLength - prefix.length,
                    )}`;
                  },
                  getPropertyValue: () => "value",
                  getPropertyPriority: () =>
                    "p".repeat(INSPECT_LIMITS.propertyNameLength + 1),
                },
              },
            ],
          },
        ],
      },
    );

    expect(result.facts).toHaveLength(INSPECT_LIMITS.declarationsPerRule);
    for (const fact of result.facts) {
      expect(fact.metadata.declarationNames).toHaveLength(
        INSPECT_LIMITS.declarationsPerRule,
      );
      expect(
        (fact.metadata.declarationNames as string[]).every(
          (name) => name.length === INSPECT_LIMITS.propertyNameLength,
        ),
      ).toBe(true);
      expect(fact.metadata.priority).toHaveLength(
        INSPECT_LIMITS.propertyNameLength,
      );
    }
  });

  it("truncates inaccessible stylesheet diagnostic reasons", () => {
    const result = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: "/inaccessible.css",
            get cssRules(): never {
              throw new Error(
                "r".repeat(INSPECT_LIMITS.valueLength + 1),
              );
            },
          },
        ],
      },
    );

    expect(result.inaccessibleStylesheets[0]?.reason).toHaveLength(
      INSPECT_LIMITS.valueLength,
    );
  });

  it("caps declaration traversal without allocating from style.length", () => {
    let itemCalls = 0;
    const result = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: "/large.css",
            cssRules: [
              {
                selectorText: ".card",
                cssText: ".card { color: red; }",
                style: {
                  length: Number.MAX_SAFE_INTEGER,
                  item(index: number) {
                    itemCalls += 1;
                    return `--property-${index}`;
                  },
                  getPropertyValue: () => "value",
                  getPropertyPriority: () => "",
                },
              },
            ],
          },
        ],
      },
    );

    expect(result.facts).toHaveLength(INSPECT_LIMITS.declarationsPerRule);
    expect(itemCalls).toBe(INSPECT_LIMITS.declarationsPerRule);
  });

  it("stops matching rules as soon as the fact budget is exhausted", () => {
    let matchCalls = 0;
    let rulesRead = 0;
    const rules = {
      *[Symbol.iterator]() {
        for (
          let index = 0;
          index < INSPECT_LIMITS.factsPerTarget + 1;
          index += 1
        ) {
          rulesRead += 1;
          yield styleRule(`.rule-${index}`, { color: "red" });
        }
      },
    };
    const result = collectCssFacts(
      {
        matches() {
          matchCalls += 1;
          return true;
        },
      },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [{ href: "/app.css", cssRules: rules }],
      },
    );

    expect(result.facts).toHaveLength(INSPECT_LIMITS.factsPerTarget);
    expect(matchCalls).toBe(INSPECT_LIMITS.factsPerTarget);
    expect(rulesRead).toBe(INSPECT_LIMITS.factsPerTarget);
  });

  it("bounds stylesheet and total rule traversal when no rules match", () => {
    let stylesheetRuleMatches = 0;
    const stylesheets = Array.from(
      { length: INSPECT_LIMITS.stylesheets + 1 },
      (_, index) => ({
        href: `/sheet-${index}.css`,
        cssRules: [styleRule(`.sheet-${index}`, { color: "red" })],
      }),
    );
    collectCssFacts(
      {
        matches() {
          stylesheetRuleMatches += 1;
          return false;
        },
      },
      { pageUrl: "http://localhost:3000/page", styleSheets: stylesheets },
    );
    expect(stylesheetRuleMatches).toBe(INSPECT_LIMITS.stylesheets);

    let totalRuleMatches = 0;
    const rules = Array.from(
      { length: INSPECT_LIMITS.cssRules + 1 },
      (_, index) => styleRule(`.rule-${index}`, { color: "red" }),
    );
    collectCssFacts(
      {
        matches() {
          totalRuleMatches += 1;
          return false;
        },
      },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [{ href: "/app.css", cssRules: rules }],
      },
    );
    expect(totalRuleMatches).toBe(INSPECT_LIMITS.cssRules);
  });

  it("bounds nested traversal and page-controlled CSS metadata", () => {
    const atLimit = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: "u".repeat(INSPECT_LIMITS.urlLength + 1),
            cssRules: [nestedRule(INSPECT_LIMITS.cssRuleDepth, true)],
          },
        ],
      },
    );
    const fact = atLimit.facts[0];

    expect(fact).toBeDefined();
    expect(fact?.metadata.sourceUrl).toHaveLength(INSPECT_LIMITS.urlLength);
    expect(fact?.metadata.cssText).toHaveLength(INSPECT_LIMITS.valueLength);
    expect(fact?.metadata.media).toHaveLength(INSPECT_LIMITS.mediaConditions);
    expect(RuntimeFactSchema.parse(fact)).toEqual(fact);

    const beyondLimit = collectCssFacts(
      { matches: () => true },
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: "/deep.css",
            cssRules: [nestedRule(INSPECT_LIMITS.cssRuleDepth + 1, false)],
          },
        ],
      },
    );
    expect(beyondLimit.facts).toEqual([]);
  });
});

function nestedRule(depth: number, oversizedMetadata: boolean): unknown {
  let nested: unknown = styleRule(".card", {
    color: "x".repeat(
      oversizedMetadata ? INSPECT_LIMITS.valueLength + 1 : 1,
    ),
  });
  if (oversizedMetadata) {
    nested = {
      ...(nested as object),
      cssText: "x".repeat(INSPECT_LIMITS.valueLength + 1),
    };
  }

  for (let index = 0; index < depth; index += 1) {
    nested = {
      media: {
        conditionText: `screen-${index}${"x".repeat(
          INSPECT_LIMITS.valueLength,
        )}`,
      },
      cssRules: [nested],
    };
  }
  return nested;
}

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
