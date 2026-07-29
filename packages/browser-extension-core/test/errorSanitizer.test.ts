import { describe, expect, it } from "vitest";
import { sanitizeErrorMessage } from "../src/errorSanitizer.js";

describe("sanitizeErrorMessage", () => {
  it("keeps one bounded line and never serializes arbitrary objects", () => {
    expect(sanitizeErrorMessage(new Error(" first\nsecond\tthird "))).toBe(
      "first second third",
    );
    expect(sanitizeErrorMessage({ token: "secret" })).toBe(
      "Unexpected error",
    );
    expect(sanitizeErrorMessage("x".repeat(500))).toHaveLength(240);
  });
});
