import { describe, expect, it } from "vitest";
import {
  BrowserBridgeClient,
  BrowserWindowLinkStore,
  createInspectPayload,
  InspectMode,
  parseLinkCode,
  registerDevtoolsPanel,
} from "../src/index.js";

describe("browser extension core exports", () => {
  it("exports transport, inspection, and DevTools runtimes", () => {
    expect(BrowserBridgeClient).toBeTypeOf("function");
    expect(BrowserWindowLinkStore).toBeTypeOf("function");
    expect(createInspectPayload).toBeTypeOf("function");
    expect(InspectMode).toBeTypeOf("function");
    expect(parseLinkCode).toBeTypeOf("function");
    expect(registerDevtoolsPanel).toBeTypeOf("function");
  });
});
