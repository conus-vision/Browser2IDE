import { describe, expect, it } from "vitest";
import { InspectMode } from "../src/inspectMode.js";

describe("InspectMode", () => {
  it("captures one inspected click and removes its listener cleanly", () => {
    let clickListener: ((event: any) => void) | undefined;
    const registrations: boolean[] = [];
    const removals: boolean[] = [];
    const selected: unknown[] = [];
    const mode = new InspectMode({
      document: {
        addEventListener(_type, listener, capture) {
          clickListener = listener;
          registrations.push(capture);
        },
        removeEventListener(_type, listener, capture) {
          if (listener === clickListener) {
            removals.push(capture);
          }
        },
      },
      onSelect: (element) => selected.push(element),
    });
    const target = {
      tagName: "A",
      id: "link",
      classList: [],
      attributes: [],
      matches: () => true,
    };
    const eventCalls: string[] = [];

    mode.enable();
    mode.enable();
    clickListener?.({
      target,
      preventDefault: () => eventCalls.push("preventDefault"),
      stopPropagation: () => eventCalls.push("stopPropagation"),
      stopImmediatePropagation: () => eventCalls.push("stopImmediatePropagation"),
    });
    mode.disable();
    mode.disable();

    expect(registrations).toEqual([true]);
    expect(selected).toEqual([target]);
    expect(eventCalls).toEqual([
      "preventDefault",
      "stopPropagation",
      "stopImmediatePropagation",
    ]);
    expect(removals).toEqual([true]);
  });

  it("ignores non-element click targets", () => {
    let clickListener: ((event: any) => void) | undefined;
    const selected: unknown[] = [];
    const mode = new InspectMode({
      document: {
        addEventListener: (_type, listener) => (clickListener = listener),
        removeEventListener() {},
      },
      onSelect: (element) => selected.push(element),
    });
    let prevented = false;

    mode.enable();
    clickListener?.({
      target: { nodeType: 3 },
      preventDefault: () => (prevented = true),
      stopPropagation() {},
      stopImmediatePropagation() {},
    });

    expect(selected).toEqual([]);
    expect(prevented).toBe(false);
  });
});
