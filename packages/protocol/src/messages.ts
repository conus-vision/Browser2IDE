import { z } from "zod";
import {
  metadataSchema,
  SourceLocationSchema,
  SourceReferenceSchema,
} from "./references.js";
import { ProtocolCapabilitySchema } from "./capabilities.js";
import { JsonObjectSchema } from "./json.js";

export const PROTOCOL_VERSION = 2 as const;

const baseMessageSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    messageId: z.string().min(1),
    metadata: metadataSchema,
  })
  .strict();

export const ClientRoleSchema = z.enum(["browser", "ide", "simulator"]);

export const ClientSourceSchema = z
  .object({
    role: ClientRoleSchema,
    id: z.string().min(1),
    label: z.string().optional(),
    url: z.string().optional(),
    metadata: metadataSchema,
  })
  .strict();

export const DomAttributeFactSchema = z
  .object({
    type: z.literal("dom-attribute"),
    name: z.string().min(1),
    value: z.string(),
    metadata: metadataSchema,
  })
  .strict();

export const CssRuleFactSchema = z
  .object({
    type: z.literal("css-rule"),
    selector: z.string().min(1),
    property: z.string().min(1),
    value: z.string(),
    source: SourceLocationSchema.optional(),
    metadata: metadataSchema,
  })
  .strict();

export const PluginRuntimeFactSchema = z
  .object({
    type: z
      .string()
      .max(128)
      .regex(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/),
    source: SourceLocationSchema.optional(),
    payload: JsonObjectSchema,
    metadata: JsonObjectSchema,
  })
  .strict();

export const RuntimeFactSchema = z.union([
  CssRuleFactSchema,
  DomAttributeFactSchema,
  PluginRuntimeFactSchema,
]);

const DomAttributeSchema = z
  .object({
    name: z.string().min(1),
    value: z.string(),
    metadata: metadataSchema,
  })
  .strict();

export const InspectSubjectSchema = z
  .object({
    selector: z.string().optional(),
    nodeId: z.string().optional(),
    text: z.string().optional(),
    attributes: z.array(DomAttributeSchema).optional(),
    metadata: metadataSchema,
  })
  .strict();

export const InspectContextSchema = z
  .object({
    url: z.string().min(1),
    frameId: z.string().optional(),
    route: z.string().optional(),
    metadata: metadataSchema,
  })
  .strict();

export const InspectTargetSchema = z
  .object({
    role: z.enum(["selected", "parent"]),
    depth: z.union([z.literal(0), z.literal(1)]),
    subject: InspectSubjectSchema,
    facts: z.array(RuntimeFactSchema),
    metadata: metadataSchema,
  })
  .strict();

export const HelloMessageSchema = baseMessageSchema
  .extend({
    type: z.literal("hello"),
    sessionId: z.string().min(1),
    authToken: z.string().min(1),
    source: ClientSourceSchema,
    capabilities: z.array(ProtocolCapabilitySchema),
  })
  .strict();

export const PairRequestMessageSchema = baseMessageSchema
  .extend({
    type: z.literal("pairRequest"),
    pairingCode: z.string().min(1),
    source: ClientSourceSchema,
  })
  .strict();

export const PairAcceptedMessageSchema = baseMessageSchema
  .extend({
    type: z.literal("pairAccepted"),
    sessionId: z.string().min(1),
    authToken: z.string().min(1),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const InspectMessageSchema = baseMessageSchema
  .extend({
    type: z.literal("inspect"),
    sessionId: z.string().min(1),
    source: ClientSourceSchema,
    targets: z.array(InspectTargetSchema).min(1).max(2),
    context: InspectContextSchema,
  })
  .strict()
  .superRefine((message, context) => {
    const selected = message.targets.filter(
      (target) => target.role === "selected",
    );
    const parents = message.targets.filter((target) => target.role === "parent");
    if (selected.length !== 1 || selected[0]?.depth !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targets"],
        message: "inspect requires one selected target at depth 0",
      });
    }
    if (parents.length > 1 || parents.some((target) => target.depth !== 1)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targets"],
        message: "inspect permits one parent target at depth 1",
      });
    }
  });

export const ReferencesMessageSchema = baseMessageSchema
  .extend({
    type: z.literal("references"),
    subject: InspectSubjectSchema,
    references: z.array(SourceReferenceSchema),
  })
  .strict();

const OpenSourceArgumentsSchema = z
  .object({
    source: SourceLocationSchema,
    metadata: metadataSchema,
  })
  .strict();

const HighlightElementArgumentsSchema = z
  .object({
    selector: z.string().min(1),
    metadata: metadataSchema,
  })
  .strict();

export const OpenSourceCommandMessageSchema = baseMessageSchema
  .extend({
    type: z.literal("command"),
    command: z.literal("openSource"),
    arguments: OpenSourceArgumentsSchema,
  })
  .strict();

export const HighlightElementCommandMessageSchema = baseMessageSchema
  .extend({
    type: z.literal("command"),
    command: z.literal("highlightElement"),
    arguments: HighlightElementArgumentsSchema,
  })
  .strict();

export const CommandMessageSchema = z.discriminatedUnion("command", [
  OpenSourceCommandMessageSchema,
  HighlightElementCommandMessageSchema,
]);

export const ProtocolErrorCodeSchema = z.enum([
  "pairing.invalidCode",
  "pairing.expiredCode",
  "auth.invalidSessionToken",
  "protocol.invalidMessage",
  "bridge.noIdeClient",
  "bridge.noBrowserClient",
  "resolver.fileNotFound",
  "resolver.sourceMapFailed",
  "browser.stylesheetInaccessible",
]);

export const ErrorMessageSchema = baseMessageSchema
  .extend({
    type: z.literal("error"),
    code: ProtocolErrorCodeSchema,
    message: z.string().min(1),
    details: metadataSchema.optional(),
  })
  .strict();

export const PingMessageSchema = baseMessageSchema
  .extend({
    type: z.literal("ping"),
    sentAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const PongMessageSchema = baseMessageSchema
  .extend({
    type: z.literal("pong"),
    pingMessageId: z.string().min(1),
    sentAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const Browser2IdeMessageSchema = z.union([
  HelloMessageSchema,
  PairRequestMessageSchema,
  PairAcceptedMessageSchema,
  InspectMessageSchema,
  ReferencesMessageSchema,
  CommandMessageSchema,
  ErrorMessageSchema,
  PingMessageSchema,
  PongMessageSchema,
]);

export type ClientRole = z.infer<typeof ClientRoleSchema>;
export type ClientSource = z.infer<typeof ClientSourceSchema>;
export type InspectSubject = z.infer<typeof InspectSubjectSchema>;
export type InspectContext = z.infer<typeof InspectContextSchema>;
export type InspectTarget = z.infer<typeof InspectTargetSchema>;
export type RuntimeFact = z.infer<typeof RuntimeFactSchema>;
export type PluginRuntimeFact = z.infer<typeof PluginRuntimeFactSchema>;
export type CssRuleFact = z.infer<typeof CssRuleFactSchema>;
export type DomAttributeFact = z.infer<typeof DomAttributeFactSchema>;
export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type PairRequestMessage = z.infer<typeof PairRequestMessageSchema>;
export type PairAcceptedMessage = z.infer<typeof PairAcceptedMessageSchema>;
export type InspectMessage = z.infer<typeof InspectMessageSchema>;
export type ReferencesMessage = z.infer<typeof ReferencesMessageSchema>;
export type OpenSourceCommandMessage = z.infer<
  typeof OpenSourceCommandMessageSchema
>;
export type HighlightElementCommandMessage = z.infer<
  typeof HighlightElementCommandMessageSchema
>;
export type CommandMessage = z.infer<typeof CommandMessageSchema>;
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCodeSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type PingMessage = z.infer<typeof PingMessageSchema>;
export type PongMessage = z.infer<typeof PongMessageSchema>;
export type Browser2IdeMessage = z.infer<typeof Browser2IdeMessageSchema>;
