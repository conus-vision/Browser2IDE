import type {
  ResolveInput,
  ResolvedReference,
  SourceResolver,
} from "./sourceTypes.js";

const CONFIDENCE_PRIORITY: Record<ResolvedReference["confidence"], number> = {
  exact: 0,
  sourcemap: 1,
  instrumented: 2,
  heuristic: 3,
  unknown: 4,
};

const STATUS_PRIORITY: Record<ResolvedReference["status"], number> = {
  active: 0,
  matched: 1,
  overridden: 2,
  external: 3,
  unmapped: 4,
  error: 5,
};

export class SourceResolverRegistry {
  private readonly resolvers = new Map<string, SourceResolver>();

  constructor(builtInResolvers: readonly SourceResolver[] = []) {
    for (const resolver of builtInResolvers) {
      this.register(resolver);
    }
  }

  register(resolver: SourceResolver): void {
    if (this.resolvers.has(resolver.id)) {
      throw new Error(`Resolver "${resolver.id}" is registered`);
    }

    this.resolvers.set(resolver.id, resolver);
  }

  async resolve(input: ResolveInput): Promise<ResolvedReference[]> {
    const factKinds = new Set<string>(input.facts.map((fact) => fact.type));
    const matchingResolvers = [...this.resolvers.values()].filter((resolver) =>
      resolver.supportedFactKinds.some((kind) => factKinds.has(kind)),
    );
    const resolved = await Promise.all(
      matchingResolvers.map((resolver) => resolver.resolve(input)),
    );

    return deduplicateReferences(resolved.flat());
  }
}

export function deduplicateReferences(
  references: readonly ResolvedReference[],
): ResolvedReference[] {
  const deduplicated = new Map<string, ResolvedReference>();

  for (const reference of references) {
    const key = referenceIdentity(reference);
    const existing = deduplicated.get(key);
    if (!existing) {
      deduplicated.set(key, { ...reference, diagnostics: [...reference.diagnostics] });
      continue;
    }

    const preferred = compareResolutionQuality(reference, existing) < 0
      ? reference
      : existing;
    deduplicated.set(key, {
      ...preferred,
      diagnostics: [...new Set([...existing.diagnostics, ...reference.diagnostics])],
    });
  }

  return [...deduplicated.values()];
}

function referenceIdentity(reference: ResolvedReference): string {
  return [
    reference.kind,
    reference.source.uri,
    reference.source.line,
    reference.label,
  ].join("\u0000");
}

function compareResolutionQuality(
  left: ResolvedReference,
  right: ResolvedReference,
): number {
  return (
    CONFIDENCE_PRIORITY[left.confidence] -
      CONFIDENCE_PRIORITY[right.confidence] ||
    STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status]
  );
}
