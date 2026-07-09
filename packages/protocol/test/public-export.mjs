import assert from "node:assert/strict";
import {
  Browser2IdeMessageSchema,
  parseMessage,
} from "@browser2ide/protocol";

const ping = {
  protocolVersion: 1,
  type: "ping",
  messageId: "msg-public-export-ping",
  sentAt: "2026-07-09T14:00:00.000Z",
  metadata: {},
};

assert.deepEqual(parseMessage(ping), ping);
assert.equal(typeof Browser2IdeMessageSchema.parse, "function");
