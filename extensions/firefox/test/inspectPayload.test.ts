import { describe, expect, it } from "vitest";
import { createInspectPayload } from "../src/inspectPayload.js";
import type { InspectableElement } from "../src/inspectMode.js";

describe("createInspectPayload", () => {
  it("collects selected and immediate-parent targets independently", () => {
    const parent = element("main", "", ["layout"], null);
    const selected = element("article", "", ["card", "featured"], parent);
    const payload = createInspectPayload(
      selected,
      fakeDocument([
        rule(".layout", parent, "display", "grid"),
        rule(".card", selected, "display", "block"),
      ]),
      locationSource(),
    );

    expect(payload.targets.map((target) => [target.role, target.depth])).toEqual([
      ["selected", 0],
      ["parent", 1],
    ]);
    expect(payload.targets[0]?.facts.map((fact) => fact.type)).toContain(
      "css-rule",
    );
    expect(payload.targets[1]?.subject.selector).toBe("main.layout");
  });

  it("omits parent for a root element", () => {
    const payload = createInspectPayload(
      element("html", "", [], null),
      fakeDocument([]),
      locationSource(),
    );

    expect(payload.targets).toHaveLength(1);
    expect(payload.targets[0]?.role).toBe("selected");
  });

  it("keeps shared rules in both targets and deduplicates browser errors", () => {
    const parent = element("main", "", ["shared"], null);
    const selected = element("article", "", ["shared"], parent);
    const inaccessible = {
      href: "https://cdn.example/vendor.css",
      get cssRules(): never {
        throw new Error("Permission denied");
      },
    };
    const payload = createInspectPayload(
      selected,
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          { href: "/dist/app.css", cssRules: [rule(".shared", null, "color", "red")] },
          inaccessible,
        ],
      },
      locationSource(),
    );

    expect(payload.targets.map((target) => target.facts.length)).toEqual([1, 1]);
    expect(payload.inaccessibleStylesheets).toEqual([
      {
        code: "browser.stylesheetInaccessible",
        sourceUrl: "https://cdn.example/vendor.css",
        reason: "Permission denied",
      },
    ]);
  });
});

function element(
  tagName: string,
  id: string,
  classes: readonly string[],
  parentElement: InspectableElement | null,
): InspectableElement {
  const value = {
    tagName,
    id,
    classList: classes,
    attributes: [],
    parentElement,
    matches(selector: string) {
      return selector === ".shared" ||
        (selector === ".layout" && classes.includes("layout")) ||
        (selector === ".card" && classes.includes("card"));
    },
  };
  return value;
}

function fakeDocument(rules: readonly unknown[]) {
  return {
    pageUrl: "http://localhost:3000/page",
    styleSheets: [{ href: "/dist/app.css", cssRules: rules }],
  };
}

function rule(
  selectorText: string,
  _element: InspectableElement | null,
  property: string,
  value: string,
) {
  return {
    selectorText,
    cssText: `${selectorText} { ${property}: ${value}; }`,
    style: {
      length: 1,
      item: () => property,
      getPropertyValue: () => value,
      getPropertyPriority: () => "",
    },
  };
}

function locationSource() {
  return {
    href: "http://localhost:3000/page?mode=dev#card",
    pathname: "/page",
    search: "?mode=dev",
    hash: "#card",
  };
}
