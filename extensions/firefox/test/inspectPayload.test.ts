import {
  INSPECT_LIMITS,
  InspectContextSchema,
  InspectTargetSchema,
} from "@browser2ide/protocol";
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

  it("bounds inspect context and browser diagnostics while preserving both targets", () => {
    const parent = element("main", "", ["layout"], null);
    const selected = element("article", "", ["card"], parent);
    const inaccessible = Array.from(
      { length: INSPECT_LIMITS.inaccessibleStylesheets + 1 },
      (_, index) => ({
        href: `https://cdn.example/${index}/${"u".repeat(
          INSPECT_LIMITS.urlLength,
        )}`,
        get cssRules(): never {
          throw new Error("r".repeat(INSPECT_LIMITS.valueLength + 1));
        },
      }),
    );
    const location = {
      href: "u".repeat(INSPECT_LIMITS.urlLength + 1),
      pathname: `/${"p".repeat(INSPECT_LIMITS.routeLength)}`,
      search: "?overflow=true",
      hash: "#target",
    };
    const payload = createInspectPayload(
      selected,
      { pageUrl: location.href, styleSheets: inaccessible },
      location,
    );

    expect(payload.targets.map((target) => target.role)).toEqual([
      "selected",
      "parent",
    ]);
    expect(payload.inaccessibleStylesheets).toHaveLength(
      INSPECT_LIMITS.inaccessibleStylesheets,
    );
    expect(payload.context.url).toHaveLength(INSPECT_LIMITS.urlLength);
    expect(payload.context.route).toHaveLength(INSPECT_LIMITS.routeLength);
    for (const target of payload.targets) {
      expect(InspectTargetSchema.parse(target)).toEqual(target);
    }
    expect(InspectContextSchema.parse(payload.context)).toEqual(payload.context);
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
