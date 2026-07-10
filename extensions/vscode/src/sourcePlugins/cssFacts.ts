import type { SelectionSnapshot } from "@browser2ide/plugin-api";
import type { CssRuleFact, RuntimeFact } from "@browser2ide/protocol";

export interface TargetCssFact {
  readonly targetRole: "selected" | "parent";
  readonly fact: CssRuleFact;
  readonly sourceUrl: string;
}

export function targetCssFacts(
  selection: SelectionSnapshot,
): TargetCssFact[] {
  const unique = new Map<string, TargetCssFact>();
  for (const target of selection.targets) {
    for (const fact of target.facts) {
      if (!isCssRuleFact(fact)) continue;
      const sourceUrl = cssFactSourceUrl(fact);
      if (!sourceUrl) continue;
      const key = JSON.stringify([
        target.role,
        sourceUrl,
        fact.selector,
        fact.source?.line ?? null,
        fact.source?.column ?? null,
        fact.metadata.rulePath ?? null,
        fact.metadata.media ?? null,
      ]);
      if (!unique.has(key)) {
        unique.set(key, { targetRole: target.role, fact, sourceUrl });
      }
    }
  }
  return [...unique.values()];
}

function isCssRuleFact(fact: RuntimeFact): fact is CssRuleFact {
  return fact.type === "css-rule" &&
    "selector" in fact &&
    "property" in fact &&
    "value" in fact;
}

export function cssFactSourceUrl(fact: CssRuleFact): string | undefined {
  for (const candidate of [
    fact.metadata.sourceUrl,
    fact.metadata.stylesheet,
    fact.source?.uri,
  ]) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}
