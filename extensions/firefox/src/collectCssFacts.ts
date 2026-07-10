import type {
  CssRuleFact,
  ProtocolErrorCode,
} from "@browser2ide/protocol";

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

  for (const [stylesheetIndex, stylesheet] of [
    ...document.styleSheets,
  ].entries()) {
    const sourceUrl =
      stylesheet.href ?? `inline-style://document/${stylesheetIndex}`;
    let rules: RuleSource[];
    try {
      rules = Array.from(stylesheet.cssRules);
    } catch (error) {
      inaccessibleStylesheets.push({
        code: "browser.stylesheetInaccessible",
        sourceUrl,
        reason: messageOf(error),
      });
      continue;
    }

    collectRules(
      element,
      rules,
      sourceUrl,
      `${stylesheetIndex}`,
      [],
      facts,
    );
  }

  return { facts, inaccessibleStylesheets };
}

function collectRules(
  element: MatchableElement,
  rules: readonly RuleSource[],
  sourceUrl: string,
  parentPath: string,
  media: readonly string[],
  facts: CssRuleFact[],
): void {
  for (const [ruleIndex, rule] of rules.entries()) {
    const rulePath = `${parentPath}.${ruleIndex}`;
    if (isStyleRule(rule)) {
      collectStyleRule(element, rule, sourceUrl, rulePath, media, facts);
      continue;
    }
    if (!isGroupRule(rule)) {
      continue;
    }

    let nestedRules: RuleSource[];
    try {
      nestedRules = Array.from(rule.cssRules);
    } catch {
      continue;
    }
    const condition = rule.media?.conditionText.trim();
    collectRules(
      element,
      nestedRules,
      sourceUrl,
      rulePath,
      condition ? [...media, condition] : media,
      facts,
    );
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
  try {
    if (!element.matches(rule.selectorText)) {
      return;
    }
  } catch {
    return;
  }

  const declarationNames = Array.from(
    { length: rule.style.length },
    (_, index) => rule.style.item(index),
  ).filter(Boolean);
  for (const property of declarationNames) {
    facts.push({
      type: "css-rule",
      selector: rule.selectorText,
      property,
      value: rule.style.getPropertyValue(property).trim(),
      metadata: {
        sourceUrl,
        cssText: rule.cssText,
        declarationNames,
        ...(media.length > 0 ? { media: [...media] } : {}),
        rulePath,
        priority: rule.style.getPropertyPriority(property),
      },
    });
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
