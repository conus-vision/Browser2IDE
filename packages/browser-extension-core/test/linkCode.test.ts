import { describe, expect, it } from "vitest";
import { parseLinkCode } from "../src/index.js";

describe("parseLinkCode", () => {
  it.each(["4873507", "48735 07", "48735-07"])(
    "parses %s into a normalized loopback endpoint",
    (input) => {
      expect(parseLinkCode(input)).toEqual({
        value: "4873507",
        port: 48_735,
        pin: "07",
        url: "ws://127.0.0.1:48735",
      });
    },
  );

  it.each([
    "",
    " ",
    "487350",
    "48735070",
    "48735a7",
    "abcdefg",
    "4873 507",
    "48735  07",
    "48735--07",
    "48735_07",
    " 4873507",
    "4873507 ",
    "48735\t07",
    "4873507\n",
  ])("rejects malformed link code %j", (input) => {
    expect(() => parseLinkCode(input)).toThrow();
  });

  it.each(["0999907", "6553607"])(
    "rejects an out-of-range port in %s",
    (input) => {
      expect(() => parseLinkCode(input)).toThrow();
    },
  );

  it.each([
    ["1000007", 10_000],
    ["6553507", 65_535],
  ])("accepts the boundary port in %s", (input, port) => {
    expect(parseLinkCode(input)).toMatchObject({ port });
  });
});
