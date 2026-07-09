import { z } from "zod";

export const metadataSchema = z.record(z.string(), z.unknown());

const oneBasedPositionSchema = z.number().int().min(1);

export const SourceLocationSchema = z
  .object({
    uri: z.string().min(1),
    line: oneBasedPositionSchema,
    column: oneBasedPositionSchema,
    endLine: oneBasedPositionSchema.optional(),
    endColumn: oneBasedPositionSchema.optional(),
    metadata: metadataSchema,
  })
  .strict();

export const SourceReferenceSchema = z
  .object({
    kind: z.enum(["style-rule", "component", "template", "script", "unknown"]),
    relation: z.enum(["styles", "renders", "defines", "listens", "templates"]),
    label: z.string(),
    source: SourceLocationSchema,
    confidence: z.enum([
      "exact",
      "sourcemap",
      "instrumented",
      "heuristic",
      "unknown",
    ]),
    status: z.enum([
      "active",
      "matched",
      "overridden",
      "external",
      "unmapped",
      "error",
    ]),
    metadata: metadataSchema,
  })
  .strict();

export type SourceLocation = z.infer<typeof SourceLocationSchema>;
export type SourceReference = z.infer<typeof SourceReferenceSchema>;
