import { describe, expect, it } from "vitest";
import {
  BrowserBridgeClient,
  createInspectPayload,
  InspectMode,
  registerDevtoolsPanel,
} from "../src/index.js";

describe("browser extension core exports", () => {
  it("exports transport, inspection, and DevTools runtimes", () => {
    expect(BrowserBridgeClient).toBeTypeOf("function");
    expect(createInspectPayload).toBeTypeOf("function");
    expect(InspectMode).toBeTypeOf("function");
    expect(registerDevtoolsPanel).toBeTypeOf("function");
  });
});
