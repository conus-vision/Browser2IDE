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
  .strict()
  .superRefine((location, context) => {
    const hasEndLine = location.endLine !== undefined;
    const hasEndColumn = location.endColumn !== undefined;

    if (hasEndLine !== hasEndColumn) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "endLine and endColumn must be provided together",
        path: hasEndLine ? ["endColumn"] : ["endLine"],
      });
      return;
    }

    if (!hasEndLine || !hasEndColumn) {
      return;
    }

    const endsBeforeStart =
      location.endLine! < location.line ||
      (location.endLine === location.line &&
        location.endColumn! < location.column);

    if (endsBeforeStart) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source range end must not be before start",
        path: ["endLine"],
      });
    }
  });

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
