import assert from "node:assert/strict";
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
  parseLinkCode,
  PanelInspectTransport,
  registerDevtoolsPanel,
  sanitizeErrorMessage,
  startBackgroundRuntime,
  startContentScriptRuntime,
  startDevtoolsRuntime,
  startPanelRuntime,
  WindowConnectionCoordinator,
} from "@browser2ide/browser-extension-core";

assert.equal(typeof BrowserBridgeClient, "function");
assert.equal(typeof BackgroundInspectCoordinator, "function");
assert.equal(typeof BackgroundRouter, "function");
assert.equal(typeof BrowserWindowLinkStore, "function");
assert.equal(typeof ContentInspectLease, "function");
assert.equal(typeof createPanelIcons, "function");
assert.equal(typeof createBackgroundRouter, "function");
assert.equal(typeof createDevtoolsPanelPortName, "function");
assert.equal(typeof createInspectPayload, "function");
assert.equal(typeof InspectMode, "function");
assert.equal(typeof PanelController, "function");
assert.equal(typeof parseLinkCode, "function");
assert.equal(typeof PanelInspectTransport, "function");
assert.equal(typeof registerDevtoolsPanel, "function");
assert.equal(typeof sanitizeErrorMessage, "function");
assert.equal(typeof startBackgroundRuntime, "function");
assert.equal(typeof startContentScriptRuntime, "function");
assert.equal(typeof startDevtoolsRuntime, "function");
assert.equal(typeof startPanelRuntime, "function");
assert.equal(typeof WindowConnectionCoordinator, "function");
