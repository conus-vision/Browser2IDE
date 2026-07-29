import { describe, expect, it } from "vitest";
import {
  BackgroundRouter,
  BackgroundInspectCoordinator,
  BrowserBridgeClient,
  BrowserWindowLinkStore,
  ContentInspectLease,
  createPanelIcons,
  createBackgroundRouter,
  createDevtoolsPanelPortName,
  createInspectPayload,
  InspectMode,
  PanelController,
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
    expect(createPanelIcons).toBeTypeOf("function");
    expect(InspectMode).toBeTypeOf("function");
    expect(parseLinkCode).toBeTypeOf("function");
    expect(PanelController).toBeTypeOf("function");
    expect(PanelInspectTransport).toBeTypeOf("function");
    expect(registerDevtoolsPanel).toBeTypeOf("function");
    expect(WindowConnectionCoordinator).toBeTypeOf("function");
  });
});
