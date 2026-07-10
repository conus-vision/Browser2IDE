import {
  Browser2IdeMessageSchema,
  type Browser2IdeMessage,
} from "./messages.js";

export function parseMessage(input: unknown): Browser2IdeMessage {
  return Browser2IdeMessageSchema.parse(input);
}

export { Browser2IdeMessageSchema };
export * from "./messages.js";
export * from "./references.js";
export * from "./capabilities.js";
export * from "./json.js";
