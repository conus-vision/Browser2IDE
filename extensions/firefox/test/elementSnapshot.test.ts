import { describe, expect, it } from "vitest";
import { InspectSubjectSchema } from "@browser2ide/protocol";
import { createElementSnapshot } from "../src/elementSnapshot.js";

describe("createElementSnapshot", () => {
  it("serializes identity and safe attributes without page text", () => {
    const subject = createElementSnapshot(
      {
        tagName: "DIV",
        id: "hero",
        classList: ["card", "featured"],
        attributes: [
          { name: "id", value: "hero" },
          { name: "class", value: "card featured" },
          { name: "data-state", value: "ready" },
          { name: "aria-label", value: "Featured card" },
          { name: "role", value: "region" },
          { name: "onclick", value: "dangerous()" },
          { name: "style", value: "display:none" },
        ],
      },
      "http://localhost:3000/page",
    );

    expect(subject).toEqual({
      selector: "div#hero.card.featured",
      nodeId: "hero",
      attributes: [
        { name: "data-state", value: "ready", metadata: {} },
        { name: "aria-label", value: "Featured card", metadata: {} },
        { name: "role", value: "region", metadata: {} },
      ],
      metadata: {
        tag: "div",
        id: "hero",
        classes: ["card", "featured"],
        pageUrl: "http://localhost:3000/page",
      },
    });
    expect(subject.text).toBeUndefined();
    expect(InspectSubjectSchema.parse(JSON.parse(JSON.stringify(subject)))).toEqual(
      subject,
    );
  });

  it("escapes selector identifiers and falls back to the tag", () => {
    expect(
      createElementSnapshot(
        {
          tagName: "ARTICLE",
          id: "",
          classList: ["card:wide"],
          attributes: [],
        },
        "http://localhost",
      ).selector,
    ).toBe("article.card\\:wide");
    expect(
      createElementSnapshot(
        { tagName: "MAIN", id: "", classList: [], attributes: [] },
        "http://localhost",
      ).selector,
    ).toBe("main");
    expect(
      createElementSnapshot(
        { tagName: "DIV", id: "", classList: ["-"], attributes: [] },
        "http://localhost",
      ).selector,
    ).toBe("div.\\-");
  });
});
