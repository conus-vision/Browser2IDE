import {
  INSPECT_LIMITS,
  type CssRuleFact,
  type ProtocolErrorCode,
} from "@browser2ide/protocol";
import {
  boundedLength,
  enumerateBounded,
  truncate,
} from "./inspectBounds.js";

export interface MatchableElement {
  matches(selector: string): boolean;
}

export interface StyleDeclarationSource {
  readonly length: number;
  item(index: number): string;
  getPropertyValue(name: string): string;
  getPropertyPriority(name: string): string;
}

export interface StyleRuleSource {
  readonly selectorText: string;
  readonly cssText: string;
  readonly style: StyleDeclarationSource;
}

export interface GroupRuleSource {
  readonly cssRules: ArrayLike<RuleSource> | Iterable<RuleSource>;
  readonly media?: { readonly conditionText: string };
}

export type RuleSource = StyleRuleSource | GroupRuleSource | object;

export interface StylesheetSource {
  readonly href: string | null;
  readonly cssRules: ArrayLike<RuleSource> | Iterable<RuleSource>;
}

export interface CssDocumentSource {
  readonly pageUrl: string;
  readonly styleSheets: Iterable<StylesheetSource>;
}

export interface InaccessibleStylesheet {
  readonly code: Extract<
    ProtocolErrorCode,
    "browser.stylesheetInaccessible"
  >;
  readonly sourceUrl: string;
  readonly reason: string;
}

export interface CssFactCollection {
  readonly facts: CssRuleFact[];
  readonly inaccessibleStylesheets: InaccessibleStylesheet[];
}

export function collectCssFacts(
  element: MatchableElement,
  document: CssDocumentSource,
): CssFactCollection {
  const facts: CssRuleFact[] = [];
  const inaccessibleStylesheets: InaccessibleStylesheet[] = [];
  const state = { rulesVisited: 0 };

  for (const [stylesheetIndex, stylesheet] of enumerateBounded(
    document.styleSheets,
    INSPECT_LIMITS.stylesheets,
  )) {
    if (facts.length >= INSPECT_LIMITS.factsPerTarget) {
      break;
    }

    const sourceUrl = truncate(
      stylesheet.href ?? `inline-style://document/${stylesheetIndex}`,
      INSPECT_LIMITS.urlLength,
    );
    try {
      collectRules(
        element,
        stylesheet.cssRules,
        sourceUrl,
        `${stylesheetIndex}`,
        [],
        0,
        facts,
        state,
      );
    } catch (error) {
      if (
        inaccessibleStylesheets.length <
        INSPECT_LIMITS.inaccessibleStylesheets
      ) {
        inaccessibleStylesheets.push({
          code: "browser.stylesheetInaccessible",
          sourceUrl,
          reason: truncate(messageOf(error), INSPECT_LIMITS.valueLength),
        });
      }
    }
  }

  return { facts, inaccessibleStylesheets };
}

function collectRules(
  element: MatchableElement,
  rules: ArrayLike<RuleSource> | Iterable<RuleSource>,
  sourceUrl: string,
  parentPath: string,
  media: readonly string[],
  depth: number,
  facts: CssRuleFact[],
  state: { rulesVisited: number },
): void {
  if (
    depth > INSPECT_LIMITS.cssRuleDepth ||
    facts.length >= INSPECT_LIMITS.factsPerTarget ||
    state.rulesVisited >= INSPECT_LIMITS.cssRules
  ) {
    return;
  }

  const remainingRules = INSPECT_LIMITS.cssRules - state.rulesVisited;
  for (const [ruleIndex, rule] of enumerateBounded(
    rules,
    remainingRules,
  )) {
    if (
      facts.length >= INSPECT_LIMITS.factsPerTarget ||
      state.rulesVisited >= INSPECT_LIMITS.cssRules
    ) {
      return;
    }
    state.rulesVisited += 1;
    const rulePath = `${parentPath}.${ruleIndex}`;
    try {
      if (isStyleRule(rule)) {
        collectStyleRule(element, rule, sourceUrl, rulePath, media, facts);
        if (
          facts.length >= INSPECT_LIMITS.factsPerTarget ||
          state.rulesVisited >= INSPECT_LIMITS.cssRules
        ) {
          return;
        }
        continue;
      }
    } catch {
      continue;
    }
    if (!isGroupRule(rule)) {
      continue;
    }

    let nestedRules: ArrayLike<RuleSource> | Iterable<RuleSource>;
    try {
      nestedRules = rule.cssRules;
    } catch {
      continue;
    }
    if (depth >= INSPECT_LIMITS.cssRuleDepth) {
      continue;
    }
    const condition = truncate(
      rule.media?.conditionText.trim() ?? "",
      INSPECT_LIMITS.valueLength,
    );
    const nextMedia =
      condition && media.length < INSPECT_LIMITS.mediaConditions
        ? [...media, condition]
        : media;
    collectRules(
      element,
      nestedRules,
      sourceUrl,
      rulePath,
      nextMedia,
      depth + 1,
      facts,
      state,
    );
    if (
      facts.length >= INSPECT_LIMITS.factsPerTarget ||
      state.rulesVisited >= INSPECT_LIMITS.cssRules
    ) {
      return;
    }
  }
}

function collectStyleRule(
  element: MatchableElement,
  rule: StyleRuleSource,
  sourceUrl: string,
  rulePath: string,
  media: readonly string[],
  facts: CssRuleFact[],
): void {
  const selector = rule.selectorText;
  if (
    selector.length === 0 ||
    selector.length > INSPECT_LIMITS.selectorLength
  ) {
    return;
  }

  try {
    if (!element.matches(selector)) {
      return;
    }
  } catch {
    return;
  }

  const remainingFacts = INSPECT_LIMITS.factsPerTarget - facts.length;
  const declarationLimit = Math.min(
    INSPECT_LIMITS.declarationsPerRule,
    remainingFacts,
  );
  const declarationNames: string[] = [];
  const declarationCount = boundedLength(rule.style.length, declarationLimit);
  for (let index = 0; index < declarationCount; index += 1) {
    try {
      const property = rule.style.item(index);
      if (
        property &&
        property.length <= INSPECT_LIMITS.propertyNameLength
      ) {
        declarationNames.push(property);
      }
    } catch {
      continue;
    }
  }

  for (const property of declarationNames) {
    if (facts.length >= INSPECT_LIMITS.factsPerTarget) {
      return;
    }

    try {
      facts.push({
        type: "css-rule",
        selector,
        property,
        value: truncate(
          rule.style.getPropertyValue(property).trim(),
          INSPECT_LIMITS.valueLength,
        ),
        metadata: {
          sourceUrl,
          cssText: truncate(rule.cssText, INSPECT_LIMITS.valueLength),
          declarationNames: [...declarationNames],
          ...(media.length > 0 ? { media: [...media] } : {}),
          rulePath: truncate(rulePath, INSPECT_LIMITS.selectorLength),
          priority: truncate(
            rule.style.getPropertyPriority(property),
            INSPECT_LIMITS.propertyNameLength,
          ),
        },
      });
    } catch {
      continue;
    }
  }
}

function isStyleRule(rule: RuleSource): rule is StyleRuleSource {
  const candidate = rule as Partial<StyleRuleSource>;
  return (
    typeof candidate.selectorText === "string" &&
    typeof candidate.cssText === "string" &&
    typeof candidate.style === "object" &&
    candidate.style !== null
  );
}

function isGroupRule(rule: RuleSource): rule is GroupRuleSource {
  return "cssRules" in rule;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
