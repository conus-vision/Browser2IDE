import {
  INSPECT_LIMITS,
  type CssRuleFact,
  type ProtocolErrorCode,
} from "@browser2ide/protocol";
import {
  boundedLength,
  consumeJsonBudget,
  createInspectByteBudget,
  enumerateBounded,
  exactBoundedUrl,
  type InspectByteBudget,
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
  readonly style: StyleDeclarationSource;
  readonly cssRules?: ArrayLike<RuleSource> | Iterable<RuleSource>;
}

interface NestedDeclarationsSource {
  readonly style: StyleDeclarationSource;
}

export interface GroupRuleSource {
  readonly cssRules: ArrayLike<RuleSource> | Iterable<RuleSource>;
  readonly media?: { readonly conditionText: string };
}

export type RuleSource = StyleRuleSource | GroupRuleSource | object;

interface StyleSelectorContext {
  readonly sourceSelector: string;
  readonly resolvedSelector: string;
}

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
  budget: InspectByteBudget = createInspectByteBudget(),
): CssFactCollection {
  const facts: CssRuleFact[] = [];
  const inaccessibleStylesheets: InaccessibleStylesheet[] = [];
  const state = { rulesVisited: 0 };

  for (const [stylesheetIndex, stylesheet] of enumerateBounded(
    document.styleSheets,
    INSPECT_LIMITS.stylesheets,
  )) {
    if (
      facts.length >= INSPECT_LIMITS.factsPerTarget ||
      budget.remainingBytes <= 0
    ) {
      break;
    }

    let sourceUrl: string | undefined;
    try {
      sourceUrl = exactBoundedUrl(
        stylesheet.href ?? `inline-style://document/${stylesheetIndex}`,
      );
    } catch {
      continue;
    }
    if (!sourceUrl) {
      continue;
    }
    try {
      collectRules(
        element,
        stylesheet.cssRules,
        sourceUrl,
        `${stylesheetIndex}`,
        [],
        undefined,
        0,
        facts,
        state,
        budget,
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
  parentSelector: StyleSelectorContext | undefined,
  depth: number,
  facts: CssRuleFact[],
  state: { rulesVisited: number },
  budget: InspectByteBudget,
): void {
  if (
    depth > INSPECT_LIMITS.cssRuleDepth ||
    facts.length >= INSPECT_LIMITS.factsPerTarget ||
    state.rulesVisited >= INSPECT_LIMITS.cssRules ||
    budget.remainingBytes <= 0
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
      state.rulesVisited >= INSPECT_LIMITS.cssRules ||
      budget.remainingBytes <= 0
    ) {
      return;
    }
    state.rulesVisited += 1;
    const rulePath = `${parentPath}.${ruleIndex}`;
    let childSelector = parentSelector;
    try {
      if (isStyleRule(rule)) {
        const selector = resolveStyleSelector(
          rule.selectorText,
          parentSelector,
        );
        if (!selector) {
          continue;
        }
        const matches = matchesSelector(element, selector.resolvedSelector);
        if (matches === undefined) {
          continue;
        }
        if (matches) {
          collectDeclarations(
            rule.style,
            selector.sourceSelector,
            sourceUrl,
            rulePath,
            media,
            facts,
            budget,
          );
        }
        childSelector = selector;
        if (
          facts.length >= INSPECT_LIMITS.factsPerTarget ||
          state.rulesVisited >= INSPECT_LIMITS.cssRules ||
          budget.remainingBytes <= 0
        ) {
          return;
        }
      } else if (isNestedDeclarationsRule(rule) && parentSelector) {
        const matches = matchesSelector(
          element,
          parentSelector.resolvedSelector,
        );
        if (matches === undefined) {
          continue;
        }
        if (matches) {
          collectDeclarations(
            rule.style,
            parentSelector.sourceSelector,
            sourceUrl,
            rulePath,
            media,
            facts,
            budget,
          );
        }
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
      rule.media?.conditionText ?? "",
      INSPECT_LIMITS.valueLength,
    ).trim();
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
      childSelector,
      depth + 1,
      facts,
      state,
      budget,
    );
    if (
      facts.length >= INSPECT_LIMITS.factsPerTarget ||
      state.rulesVisited >= INSPECT_LIMITS.cssRules ||
      budget.remainingBytes <= 0
    ) {
      return;
    }
  }
}

function collectDeclarations(
  style: StyleDeclarationSource,
  selector: string,
  sourceUrl: string,
  rulePath: string,
  media: readonly string[],
  facts: CssRuleFact[],
  budget: InspectByteBudget,
): void {
  const remainingFacts = INSPECT_LIMITS.factsPerTarget - facts.length;
  const declarationLimit = Math.min(
    INSPECT_LIMITS.declarationsPerRule,
    remainingFacts,
  );
  const declarationNames: string[] = [];
  const declarationCount = boundedLength(style.length, declarationLimit);
  for (let index = 0; index < declarationCount; index += 1) {
    try {
      const property = style.item(index);
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
    if (
      facts.length >= INSPECT_LIMITS.factsPerTarget ||
      budget.remainingBytes <= 0
    ) {
      return;
    }

    try {
      const fact: CssRuleFact = {
        type: "css-rule",
        selector,
        property,
        value: truncate(
          style.getPropertyValue(property),
          INSPECT_LIMITS.valueLength,
        ).trim(),
        metadata: {
          sourceUrl,
          ...(media.length > 0 ? { media: [...media] } : {}),
          rulePath: truncate(rulePath, INSPECT_LIMITS.selectorLength),
        },
      };
      if (!consumeJsonBudget(budget, fact)) {
        return;
      }
      facts.push(fact);
    } catch {
      continue;
    }
  }
}

function resolveStyleSelector(
  selector: string,
  parent: StyleSelectorContext | undefined,
): StyleSelectorContext | undefined {
  if (
    selector.length === 0 ||
    selector.length > INSPECT_LIMITS.selectorLength
  ) {
    return undefined;
  }

  const resolvedSelector = parent
    ? resolveNestedSelector(selector, parent.resolvedSelector)
    : lexicallyValidSelector(selector)
      ? selector
      : undefined;
  if (!resolvedSelector) {
    return undefined;
  }

  return {
    sourceSelector: selector,
    resolvedSelector,
  };
}

function resolveNestedSelector(
  selector: string,
  parentSelector: string,
): string | undefined {
  const replacement = `:is(${parentSelector})`;
  let result = "";
  let quote: "\"" | "'" | undefined;
  let escaped = false;
  let nestingSelectorFound = false;
  let parentheses = 0;
  let brackets = 0;
  let topLevelComma = false;

  for (const character of selector) {
    if (escaped) {
      if (result.length >= INSPECT_LIMITS.selectorLength) {
        return undefined;
      }
      result += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      if (result.length >= INSPECT_LIMITS.selectorLength) {
        return undefined;
      }
      result += character;
      escaped = true;
      continue;
    }
    if (quote) {
      if (result.length >= INSPECT_LIMITS.selectorLength) {
        return undefined;
      }
      result += character;
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "\"" || character === "'") {
      if (result.length >= INSPECT_LIMITS.selectorLength) {
        return undefined;
      }
      result += character;
      quote = character;
      continue;
    }
    if (character === "(") {
      parentheses += 1;
    } else if (character === ")") {
      if (parentheses === 0) {
        return undefined;
      }
      parentheses -= 1;
    } else if (character === "[") {
      brackets += 1;
    } else if (character === "]") {
      if (brackets === 0) {
        return undefined;
      }
      brackets -= 1;
    } else if (
      character === "," &&
      parentheses === 0 &&
      brackets === 0
    ) {
      topLevelComma = true;
    }

    const addition = character === "&" ? replacement : character;
    if (
      result.length + addition.length >
      INSPECT_LIMITS.selectorLength
    ) {
      return undefined;
    }
    result += addition;
    nestingSelectorFound ||= character === "&";
  }

  if (escaped || quote || parentheses !== 0 || brackets !== 0) {
    return undefined;
  }
  if (nestingSelectorFound) {
    return result;
  }
  if (topLevelComma) {
    return undefined;
  }

  const descendantSelector = `${replacement} ${selector.trim()}`;
  return descendantSelector.length <= INSPECT_LIMITS.selectorLength
    ? descendantSelector
    : undefined;
}

function lexicallyValidSelector(selector: string): boolean {
  let quote: "\"" | "'" | undefined;
  let escaped = false;
  let parentheses = 0;
  let brackets = 0;

  for (const character of selector) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === "(") {
      parentheses += 1;
    } else if (character === ")") {
      if (parentheses === 0) {
        return false;
      }
      parentheses -= 1;
    } else if (character === "[") {
      brackets += 1;
    } else if (character === "]") {
      if (brackets === 0) {
        return false;
      }
      brackets -= 1;
    }
  }

  return !escaped && !quote && parentheses === 0 && brackets === 0;
}

function matchesSelector(
  element: MatchableElement,
  selector: string,
): boolean | undefined {
  try {
    return element.matches(selector);
  } catch {
    return undefined;
  }
}

function isStyleRule(rule: RuleSource): rule is StyleRuleSource {
  const candidate = rule as Partial<StyleRuleSource>;
  return (
    typeof candidate.selectorText === "string" &&
    typeof candidate.style === "object" &&
    candidate.style !== null
  );
}

function isGroupRule(rule: RuleSource): rule is GroupRuleSource {
  return "cssRules" in rule;
}

function isNestedDeclarationsRule(
  rule: RuleSource,
): rule is NestedDeclarationsSource {
  if ("selectorText" in rule || "cssRules" in rule) {
    return false;
  }
  const candidate = rule as Partial<NestedDeclarationsSource> & {
    readonly constructor?: { readonly name?: unknown };
  };
  if (typeof candidate.style !== "object" || candidate.style === null) {
    return false;
  }
  const constructorName = candidate.constructor?.name;
  return (
    constructorName === undefined ||
    constructorName === "Object" ||
    constructorName === "CSSNestedDeclarations"
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
