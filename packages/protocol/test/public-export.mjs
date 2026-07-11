import assert from "node:assert/strict";
import {
  AuthenticatedMessageSchema,
  BridgeInstanceIdSchema,
  Browser2IdeMessageSchema,
  LinkAcceptedMessageSchema,
  LinkRequestMessageSchema,
  PROTOCOL_VERSION,
  UnlinkMessageSchema,
  parseMessage,
} from "@browser2ide/protocol";

const ping = {
  protocolVersion: PROTOCOL_VERSION,
  type: "ping",
  messageId: "msg-public-export-ping",
  sentAt: "2026-07-09T14:00:00.000Z",
  metadata: {},
};

assert.deepEqual(parseMessage(ping), ping);
assert.equal(PROTOCOL_VERSION, 3);
assert.equal(typeof Browser2IdeMessageSchema.parse, "function");
assert.equal(typeof BridgeInstanceIdSchema.parse, "function");
assert.equal(typeof LinkRequestMessageSchema.parse, "function");
assert.equal(typeof LinkAcceptedMessageSchema.parse, "function");
assert.equal(typeof AuthenticatedMessageSchema.parse, "function");
assert.equal(typeof UnlinkMessageSchema.parse, "function");
