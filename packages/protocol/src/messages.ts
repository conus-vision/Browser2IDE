import { z } from "zod";
import {
  metadataSchema,
  SourceLocationSchema,
  SourceReferenceSchema,
} from "./references.js";
import { ProtocolCapabilitySchema } from "./capabilities.js";

const baseMessageSchema = z
  .object({
    protocolVersion: z.literal(1),
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

export const RuntimeFactSchema = z.discriminatedUnion("type", [
  CssRuleFactSchema,
  DomAttributeFactSchema,
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

export const HelloMessageSchema = baseMessageSchema
  .extend({
    type: z.literal("hello"),
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
    subject: InspectSubjectSchema,
    facts: z.array(RuntimeFactSchema),
    context: InspectContextSchema,
  })
  .strict();

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

export const ErrorMessageSchema = baseMessageSchema
  .extend({
    type: z.literal("error"),
    code: z.string().min(1),
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
export type RuntimeFact = z.infer<typeof RuntimeFactSchema>;
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
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type PingMessage = z.infer<typeof PingMessageSchema>;
export type PongMessage = z.infer<typeof PongMessageSchema>;
export type Browser2IdeMessage = z.infer<typeof Browser2IdeMessageSchema>;
