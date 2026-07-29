import { createHash } from "node:crypto";
import postcss, {
  type AtRule,
  type ChildNode,
  type Container,
  type Document,
  type Root,
  type Rule,
} from "postcss";
import { parse as parseScss } from "postcss-scss";
import type {
  SourceDocument,
  SourcePosition,
  SourceRange,
} from "@browser2ide/plugin-api";
import {
  INSPECT_LIMITS,
  type CssRuleFact,
} from "@browser2ide/protocol";

export type StylesheetSyntax = "css" | "scss";

export interface StylesheetRule {
  readonly selector: string;
  readonly normalizedSelector: string;
  readonly range: SourceRange;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly media: readonly string[];
  readonly path: string;
  readonly identities: readonly StylesheetRuleIdentity[];
}

interface StylesheetRuleIdentity {
  readonly selector: string;
  readonly normalizedSelector: string;
  readonly media: readonly string[];
  readonly path: string;
  readonly nested: boolean;
}

export interface ParsedStylesheet {
  readonly uri: string;
  readonly syntax: StylesheetSyntax;
  readonly document: SourceDocument;
  readonly rules: readonly StylesheetRule[];
}

export class StylesheetAstCache {
  private readonly documents = new Map<string, ParsedStylesheet>();
  private readonly generated = new Map<string, ParsedStylesheet>();

  public parseDocument(
    document: SourceDocument,
    syntax: StylesheetSyntax,
  ): ParsedStylesheet {
    const key = `${syntax}:${document.uri}:${document.version}`;
    const cached = this.documents.get(key);
    if (cached) return cached;

    for (const candidate of this.documents.keys()) {
      if (candidate.startsWith(`${syntax}:${document.uri}:`)) {
        this.documents.delete(candidate);
      }
    }
    const parsed = parseStylesheet(document, syntax);
    this.documents.set(key, parsed);
    return parsed;
  }

  public parseText(
    uri: string,
    syntax: StylesheetSyntax,
    text: string,
  ): ParsedStylesheet {
    const hash = createHash("sha256").update(text).digest("hex");
    const key = `${syntax}:${uri}:${hash}`;
    const cached = this.generated.get(key);
    if (cached) return cached;

    const parsed = parseStylesheet(textDocument(uri, text), syntax);
    this.generated.set(key, parsed);
    return parsed;
  }
}

export function findMatchingCssRules(
  rules: readonly StylesheetRule[],
  fact: CssRuleFact,
  document: SourceDocument,
): StylesheetRule[] {
  if (fact.source) {
    const offset = document.offsetAt({
      line: fact.source.line - 1,
      character: fact.source.column - 1,
    });
    const containing = rules.filter(
      (rule) => rule.startOffset <= offset && offset < rule.endOffset,
    );
    const smallest = smallestRule(containing);
    return smallest ? [smallest] : [];
  }

  const media = factMedia(fact);
  if (media === null) return [];
  const rulePath = fact.metadata.rulePath;
  const browserPath = parseBrowserRulePath(rulePath);
  if (browserPath !== undefined) {
    const selector = fact.selector;
    const exactPath = rules.filter((rule) =>
      rule.identities.some((identity) =>
        identity.path === browserPath &&
        sameSelector(identity, selector) &&
        (media === undefined || sameMedia(identity.media, media))
      )
    );
    if (exactPath.length > 0) return exactPath;
  }

  return rules.filter(
    (rule) =>
      rule.identities.some((identity) =>
        sameSelector(identity, fact.selector) &&
        (media === undefined || sameMedia(identity.media, media))
      ),
  );
}

export function smallestContainingRule(
  rules: readonly StylesheetRule[],
  offset: number,
): StylesheetRule | undefined {
  return smallestRule(
    rules.filter(
      (rule) => rule.startOffset <= offset && offset < rule.endOffset,
    ),
  );
}

export function normalizeSelector(selector: string): string {
  return selector.trim();
}

function parseStylesheet(
  document: SourceDocument,
  syntax: StylesheetSyntax,
): ParsedStylesheet {
  const text = document.getText();
  const root = syntax === "scss"
    ? parseScss(text, { from: document.uri })
    : postcss.parse(text, { from: document.uri });
  const identities = collectCssomIdentities(root);
  const rules: StylesheetRule[] = [];
  root.walkRules((node) => {
    const rule = ruleFromNode(node, document, identities.get(node) ?? []);
    if (rule) rules.push(rule);
  });
  return { uri: document.uri, syntax, document, rules };
}

function ruleFromNode(
  node: Rule,
  document: SourceDocument,
  identities: readonly StylesheetRuleIdentity[],
): StylesheetRule | undefined {
  const start = node.source?.start?.offset;
  const end = node.source?.end?.offset;
  if (start === undefined || end === undefined || end <= start) {
    return undefined;
  }
  return {
    selector: node.selector,
    normalizedSelector: normalizeSelector(node.selector),
    range: {
      start: document.positionAt(start),
      end: document.positionAt(end),
    },
    startOffset: start,
    endOffset: end,
    media: containingMedia(node),
    path: identities[0]?.path ?? "",
    identities,
  };
}

function collectCssomIdentities(
  root: Root,
): ReadonlyMap<Rule, readonly StylesheetRuleIdentity[]> {
  const identities = new Map<Rule, StylesheetRuleIdentity[]>();
  indexCssomChildren(root, [], undefined, identities);
  return identities;
}

function indexCssomChildren(
  container: Container,
  parentPath: readonly number[],
  owner: Rule | undefined,
  identities: Map<Rule, StylesheetRuleIdentity[]>,
): void {
  for (const [index, child] of cssomChildren(container, owner).entries()) {
    const path = [...parentPath, index];
    if (child.kind === "declarations") {
      addIdentity(
        identities,
        child.owner,
        path,
        child.owner.selector,
        containingMediaFrom(container),
        hasRuleAncestor(child.owner),
      );
      continue;
    }

    if (child.node.type === "rule") {
      addIdentity(
        identities,
        child.node,
        path,
        child.node.selector,
        containingMedia(child.node),
        owner !== undefined,
      );
      indexCssomChildren(child.node, path, child.node, identities);
      continue;
    }

    indexCssomChildren(child.node, path, owner, identities);
  }
}

type CssomChild =
  | { readonly kind: "node"; readonly node: Rule | AtRule }
  | { readonly kind: "declarations"; readonly owner: Rule };

function cssomChildren(
  container: Container,
  owner: Rule | undefined,
): CssomChild[] {
  const result: CssomChild[] = [];
  const canOwnDeclarations = owner !== undefined;
  let cssRuleSeen = container.type !== "rule";
  let declarationsPending = false;

  const flushDeclarations = (): void => {
    if (declarationsPending && owner) {
      result.push({ kind: "declarations", owner });
    }
    declarationsPending = false;
  };

  for (const node of container.nodes ?? []) {
    if (isCssomRuleNode(node)) {
      flushDeclarations();
      result.push({ kind: "node", node });
      cssRuleSeen = true;
      continue;
    }
    if (node.type === "decl" && canOwnDeclarations && cssRuleSeen) {
      declarationsPending = true;
    }
  }
  flushDeclarations();
  return result;
}

function isCssomRuleNode(node: ChildNode): node is Rule | AtRule {
  return node.type === "rule" ||
    (node.type === "atrule" && node.name.toLowerCase() !== "charset");
}

function addIdentity(
  identities: Map<Rule, StylesheetRuleIdentity[]>,
  rule: Rule,
  path: readonly number[],
  selector: string,
  media: readonly string[],
  nested: boolean,
): void {
  const entries = identities.get(rule) ?? [];
  entries.push({
    selector,
    normalizedSelector: normalizeSelector(selector),
    media,
    path: path.join("."),
    nested,
  });
  identities.set(rule, entries);
}

function containingMedia(node: Rule): readonly string[] {
  return containingMediaFrom(node.parent);
}

function containingMediaFrom(
  node: Container | Document | undefined,
): readonly string[] {
  const media: string[] = [];
  let current: Container | Document | undefined = node;
  while (current) {
    if (current.type === "atrule" && (current as AtRule).name === "media") {
      media.unshift(normalizeMedia((current as AtRule).params));
    }
    current = current.parent;
  }
  return media;
}

function hasRuleAncestor(node: Rule): boolean {
  let parent: Container | Document | undefined = node.parent;
  while (parent) {
    if (parent.type === "rule") return true;
    parent = parent.parent;
  }
  return false;
}

function parseBrowserRulePath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > INSPECT_LIMITS.selectorLength
  ) {
    return undefined;
  }
  const segments = value.split(".");
  if (
    segments.length < 2 ||
    segments.length > INSPECT_LIMITS.cssRuleDepth + 2
  ) {
    return undefined;
  }
  for (const [index, segment] of segments.entries()) {
    if (!/^(?:0|[1-9]\d*)$/.test(segment)) return undefined;
    const numeric = Number(segment);
    const upperBound = index === 0
      ? INSPECT_LIMITS.stylesheets
      : INSPECT_LIMITS.cssRules;
    if (!Number.isSafeInteger(numeric) || numeric >= upperBound) {
      return undefined;
    }
  }
  return segments.slice(1).join(".");
}

function sameSelector(
  identity: StylesheetRuleIdentity,
  selector: string,
): boolean {
  if (
    identity.selector.length > INSPECT_LIMITS.selectorLength ||
    selector.length > INSPECT_LIMITS.selectorLength
  ) {
    return false;
  }
  if (identity.selector.trim() === selector.trim()) return true;

  const left = identity.nested
    ? absolutizeNestedSelector(identity.selector)
    : identity.selector;
  const right = identity.nested
    ? absolutizeNestedSelector(selector)
    : selector;
  if (left === undefined || right === undefined) return false;

  const leftKey = canonicalizeCss(left, "selector");
  const rightKey = canonicalizeCss(right, "selector");
  return leftKey !== undefined && leftKey === rightKey;
}

function absolutizeNestedSelector(selector: string): string | undefined {
  const branches = splitTopLevelSelectorList(selector);
  if (!branches) return undefined;
  return branches.map((branch) =>
    hasNestingSelector(branch) ? branch : `& ${branch}`
  ).join(", ");
}

function hasNestingSelector(selector: string): boolean {
  let quote: "\"" | "'" | undefined;
  let escaped = false;
  let inComment = false;
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index]!;
    const next = selector[index + 1];
    if (inComment) {
      if (character === "*" && next === "/") {
        inComment = false;
        index += 1;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "/" && next === "*") {
      inComment = true;
      index += 1;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "&") return true;
  }
  return false;
}

function factMedia(
  fact: CssRuleFact,
): readonly string[] | undefined | null {
  const value = fact.metadata.media;
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > INSPECT_LIMITS.mediaConditions ||
    !value.every((entry) =>
      typeof entry === "string" &&
      entry.length <= INSPECT_LIMITS.valueLength
    )
  ) {
    return null;
  }
  return value.map(normalizeMedia);
}

function sameMedia(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      if (other === undefined) return false;
      if (entry.trim() === other.trim()) return true;
      const leftKey = canonicalizeCss(entry, "media");
      const rightKey = canonicalizeCss(other, "media");
      return leftKey !== undefined && leftKey === rightKey;
    });
}

function normalizeMedia(value: string): string {
  return value.trim();
}

type CanonicalMode = "selector" | "media";

type CssToken =
  | { readonly kind: "symbol"; readonly value: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "escape"; readonly value: string }
  | { readonly kind: "whitespace"; readonly value: " " };

function canonicalizeCss(
  value: string,
  mode: CanonicalMode,
): string | undefined {
  const limit = mode === "selector"
    ? INSPECT_LIMITS.selectorLength
    : INSPECT_LIMITS.valueLength;
  if (value.length === 0 || value.length > limit) return undefined;
  const tokens = tokenizeCss(value);
  if (!tokens) return undefined;

  const canonical: CssToken[] = [];
  let whitespacePending = false;
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  for (const token of tokens) {
    if (token.kind === "whitespace") {
      whitespacePending = canonical.length > 0;
      continue;
    }

    const previous = canonical.at(-1);
    if (
      whitespacePending &&
      previous &&
      isMeaningfulWhitespace(previous, token, mode, bracketDepth)
    ) {
      canonical.push({ kind: "whitespace", value: " " });
    }
    whitespacePending = false;

    if (token.kind === "symbol") {
      if (token.value === "[") bracketDepth += 1;
      if (token.value === "]") {
        bracketDepth -= 1;
        if (bracketDepth < 0) return undefined;
      }
      if (token.value === "(") parenthesisDepth += 1;
      if (token.value === ")") {
        parenthesisDepth -= 1;
        if (parenthesisDepth < 0) return undefined;
      }
    }
    canonical.push(token);
  }
  if (bracketDepth !== 0 || parenthesisDepth !== 0) return undefined;
  return JSON.stringify(canonical);
}

function tokenizeCss(value: string): CssToken[] | undefined {
  const tokens: CssToken[] = [];
  for (let index = 0; index < value.length;) {
    const character = value[index]!;
    const next = value[index + 1];
    if (isCssWhitespace(character)) {
      while (index < value.length && isCssWhitespace(value[index]!)) index += 1;
      tokens.push({ kind: "whitespace", value: " " });
      continue;
    }
    if (character === "/" && next === "*") {
      const end = value.indexOf("*/", index + 2);
      if (end < 0) return undefined;
      index = end + 2;
      continue;
    }
    if (character === "\"" || character === "'") {
      const result = consumeCssString(value, index, character);
      if (!result) return undefined;
      tokens.push({ kind: "string", value: result.value });
      index = result.nextIndex;
      continue;
    }
    if (character === "\\") {
      const result = consumeCssEscape(value, index);
      if (!result) return undefined;
      tokens.push({ kind: "escape", value: result.value });
      index = result.nextIndex;
      continue;
    }

    const pair = `${character}${next ?? ""}`;
    if (CSS_TWO_CHARACTER_TOKENS.has(pair)) {
      tokens.push({ kind: "symbol", value: pair });
      index += 2;
      continue;
    }
    tokens.push({ kind: "symbol", value: character });
    index += 1;
  }
  return tokens;
}

const CSS_TWO_CHARACTER_TOKENS = new Set([
  "||",
  "~=",
  "|=",
  "^=",
  "$=",
  "*=",
  "<=",
  ">=",
]);

function consumeCssString(
  value: string,
  start: number,
  quote: "\"" | "'",
): { readonly value: string; readonly nextIndex: number } | undefined {
  let decoded = "";
  for (let index = start + 1; index < value.length;) {
    const character = value[index]!;
    if (character === quote) {
      return { value: decoded, nextIndex: index + 1 };
    }
    if (character === "\n" || character === "\r" || character === "\f") {
      return undefined;
    }
    if (character === "\\") {
      const result = consumeCssEscape(value, index);
      if (!result) return undefined;
      decoded += result.value;
      index = result.nextIndex;
      continue;
    }
    decoded += character;
    index += 1;
  }
  return undefined;
}

function consumeCssEscape(
  value: string,
  start: number,
): { readonly value: string; readonly nextIndex: number } | undefined {
  let index = start + 1;
  const character = value[index];
  if (character === undefined) return undefined;
  if (character === "\r") {
    return {
      value: "",
      nextIndex: value[index + 1] === "\n" ? index + 2 : index + 1,
    };
  }
  if (character === "\n" || character === "\f") {
    return { value: "", nextIndex: index + 1 };
  }
  if (!/[0-9a-fA-F]/.test(character)) {
    return { value: character, nextIndex: index + 1 };
  }

  const hexStart = index;
  while (
    index < value.length &&
    index - hexStart < 6 &&
    /[0-9a-fA-F]/.test(value[index]!)
  ) {
    index += 1;
  }
  const codePoint = Number.parseInt(value.slice(hexStart, index), 16);
  if (index < value.length && isCssWhitespace(value[index]!)) {
    if (value[index] === "\r" && value[index + 1] === "\n") index += 2;
    else index += 1;
  }
  const decoded = codePoint === 0 ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ? "\uFFFD"
    : String.fromCodePoint(codePoint);
  return { value: decoded, nextIndex: index };
}

function isMeaningfulWhitespace(
  previous: CssToken,
  next: CssToken,
  mode: CanonicalMode,
  bracketDepth: number,
): boolean {
  if (mode === "selector") {
    if (bracketDepth > 0) return false;
    return !isSelectorSpacingBoundary(previous, "after") &&
      !isSelectorSpacingBoundary(next, "before");
  }
  return !isMediaSpacingBoundary(previous, "after") &&
    !isMediaSpacingBoundary(next, "before");
}

function isSelectorSpacingBoundary(
  token: CssToken,
  side: "before" | "after",
): boolean {
  if (token.kind !== "symbol") return false;
  if ([",", ">", "+", "~", "||"].includes(token.value)) return true;
  return side === "after" ? token.value === "(" : token.value === ")";
}

function isMediaSpacingBoundary(
  token: CssToken,
  side: "before" | "after",
): boolean {
  if (token.kind !== "symbol") return false;
  if ([":", ",", "/", "<", "<=", ">", ">=", "="].includes(token.value)) {
    return true;
  }
  return side === "after" ? token.value === "(" : token.value === ")";
}

function splitTopLevelSelectorList(value: string): string[] | undefined {
  if (value.length === 0 || value.length > INSPECT_LIMITS.selectorLength) {
    return undefined;
  }
  const branches: string[] = [];
  let start = 0;
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  let quote: "\"" | "'" | undefined;
  let escaped = false;
  let inComment = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const next = value[index + 1];
    if (inComment) {
      if (character === "*" && next === "/") {
        inComment = false;
        index += 1;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "/" && next === "*") {
      inComment = true;
      index += 1;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[") bracketDepth += 1;
    else if (character === "]") bracketDepth -= 1;
    else if (character === "(") parenthesisDepth += 1;
    else if (character === ")") parenthesisDepth -= 1;
    if (bracketDepth < 0 || parenthesisDepth < 0) return undefined;
    if (character === "," && bracketDepth === 0 && parenthesisDepth === 0) {
      const branch = value.slice(start, index).trim();
      if (branch.length === 0) return undefined;
      branches.push(branch);
      start = index + 1;
    }
  }
  if (
    escaped ||
    quote !== undefined ||
    inComment ||
    bracketDepth !== 0 ||
    parenthesisDepth !== 0
  ) {
    return undefined;
  }
  const branch = value.slice(start).trim();
  if (branch.length === 0) return undefined;
  branches.push(branch);
  return branches;
}

function isCssWhitespace(value: string): boolean {
  return value === " " ||
    value === "\n" ||
    value === "\r" ||
    value === "\t" ||
    value === "\f";
}

function smallestRule(
  rules: readonly StylesheetRule[],
): StylesheetRule | undefined {
  return [...rules].sort(
    (left, right) =>
      left.endOffset - left.startOffset - (right.endOffset - right.startOffset),
  )[0];
}

function textDocument(uri: string, text: string): SourceDocument {
  const lineOffsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lineOffsets.push(index + 1);
  }
  return {
    uri,
    languageId: "",
    version: 0,
    getText: () => text,
    positionAt: (offset) => positionAt(lineOffsets, text.length, offset),
    offsetAt: (position) => offsetAt(lineOffsets, text, position),
  };
}

function positionAt(
  lineOffsets: readonly number[],
  length: number,
  offset: number,
): SourcePosition {
  const clamped = Math.max(0, Math.min(offset, length));
  let low = 0;
  let high = lineOffsets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((lineOffsets[middle] ?? 0) > clamped) high = middle;
    else low = middle + 1;
  }
  const line = Math.max(0, low - 1);
  return { line, character: clamped - (lineOffsets[line] ?? 0) };
}

function offsetAt(
  lineOffsets: readonly number[],
  text: string,
  position: SourcePosition,
): number {
  const line = Math.max(0, Math.min(position.line, lineOffsets.length - 1));
  const start = lineOffsets[line] ?? 0;
  const next = lineOffsets[line + 1] ?? text.length;
  const lineEnd = line + 1 < lineOffsets.length ? Math.max(start, next - 1) : next;
  return start + Math.max(0, Math.min(position.character, lineEnd - start));
}
