import assert from "node:assert/strict";
import {
  BrowserBridgeClient,
  BrowserWindowLinkStore,
  createInspectPayload,
  InspectMode,
  parseLinkCode,
  registerDevtoolsPanel,
} from "@browser2ide/browser-extension-core";

assert.equal(typeof BrowserBridgeClient, "function");
assert.equal(typeof BrowserWindowLinkStore, "function");
assert.equal(typeof createInspectPayload, "function");
assert.equal(typeof InspectMode, "function");
assert.equal(typeof parseLinkCode, "function");
assert.equal(typeof registerDevtoolsPanel, "function");
