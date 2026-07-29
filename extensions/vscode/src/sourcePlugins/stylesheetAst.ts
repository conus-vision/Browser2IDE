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

  const rulePath = fact.metadata.rulePath;
  const browserPath = parseBrowserRulePath(rulePath);
  if (browserPath !== undefined) {
    const selector = fact.selector;
    const media = factMedia(fact);
    const exactPath = rules.filter((rule) =>
      rule.identities.some((identity) =>
        identity.path === browserPath &&
        sameSelector(identity, selector) &&
        (media === undefined || sameMedia(identity.media, media))
      )
    );
    if (exactPath.length > 0) return exactPath;
  }

  const selector = normalizeSelector(fact.selector);
  const media = factMedia(fact);
  return rules.filter(
    (rule) =>
      rule.identities.some((identity) =>
        (identity.normalizedSelector === selector ||
          sameSelector(identity, fact.selector)) &&
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
  return selector.trim().replace(/\s+/g, " ");
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
  return node.type === "rule" || node.type === "atrule";
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
  const normalized = normalizeSelector(selector);
  if (identity.normalizedSelector === normalized) return true;
  return identity.nested &&
    absolutizeNestedSelector(identity.selector) ===
      absolutizeNestedSelector(selector);
}

function absolutizeNestedSelector(selector: string): string {
  const normalized = normalizeSelector(selector);
  return hasNestingSelector(normalized) ? normalized : `& ${normalized}`;
}

function hasNestingSelector(selector: string): boolean {
  let quote: "\"" | "'" | undefined;
  let escaped = false;
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
      if (character === quote) quote = undefined;
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

function factMedia(fact: CssRuleFact): readonly string[] | undefined {
  const value = fact.metadata.media;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return value.map(normalizeMedia);
}

function sameMedia(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((entry, index) => entry === right[index]);
}

function normalizeMedia(value: string): string {
  return value.trim().replace(/\s+/g, " ");
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
