import { describe, expect, it } from "vitest";
import {
  BackgroundRouter,
  BackgroundInspectCoordinator,
  BrowserBridgeClient,
  BrowserWindowLinkStore,
  ContentInspectLease,
  createBackgroundRouter,
  createDevtoolsPanelPortName,
  createInspectPayload,
  InspectMode,
  PanelInspectTransport,
  parseLinkCode,
  registerDevtoolsPanel,
  WindowConnectionCoordinator,
} from "../src/index.js";

describe("browser extension core exports", () => {
  it("exports transport, inspection, and DevTools runtimes", () => {
    expect(BrowserBridgeClient).toBeTypeOf("function");
    expect(BackgroundInspectCoordinator).toBeTypeOf("function");
    expect(BackgroundRouter).toBeTypeOf("function");
    expect(BrowserWindowLinkStore).toBeTypeOf("function");
    expect(ContentInspectLease).toBeTypeOf("function");
    expect(createBackgroundRouter).toBeTypeOf("function");
    expect(createDevtoolsPanelPortName).toBeTypeOf("function");
    expect(createInspectPayload).toBeTypeOf("function");
    expect(InspectMode).toBeTypeOf("function");
    expect(parseLinkCode).toBeTypeOf("function");
    expect(PanelInspectTransport).toBeTypeOf("function");
    expect(registerDevtoolsPanel).toBeTypeOf("function");
    expect(WindowConnectionCoordinator).toBeTypeOf("function");
  });
});
