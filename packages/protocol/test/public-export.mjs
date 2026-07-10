import assert from "node:assert/strict";
import {
  Browser2IdeMessageSchema,
  PROTOCOL_VERSION,
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
assert.equal(typeof Browser2IdeMessageSchema.parse, "function");
