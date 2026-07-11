import { z } from "zod";

export const ProtocolCapability = {
  Inspect: "inspect",
  References: "references",
  OpenSource: "openSource",
  Link: "link",
} as const;

export const ProtocolCapabilitySchema = z.enum([
  ProtocolCapability.Inspect,
  ProtocolCapability.References,
  ProtocolCapability.OpenSource,
  ProtocolCapability.Link,
]);

export type ProtocolCapability =
  (typeof ProtocolCapability)[keyof typeof ProtocolCapability];
