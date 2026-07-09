import { z } from "zod";

export const ProtocolCapability = {
  Inspect: "inspect",
  References: "references",
  OpenSource: "openSource",
  Pairing: "pairing",
} as const;

export const ProtocolCapabilitySchema = z.enum([
  ProtocolCapability.Inspect,
  ProtocolCapability.References,
  ProtocolCapability.OpenSource,
  ProtocolCapability.Pairing,
]);

export type ProtocolCapability =
  (typeof ProtocolCapability)[keyof typeof ProtocolCapability];
