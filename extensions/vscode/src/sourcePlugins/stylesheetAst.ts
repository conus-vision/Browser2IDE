import { createHash } from "node:crypto";
import postcss, {
  type AtRule,
  type Container,
  type Document,
  type Root,
  type Rule,
} from "postcss";
import selectorParser from "postcss-selector-parser";
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
  readonly range: SourceRange;
  readonly startOffset: number;
  readonly endOffset: number;
}

type RuleIndex = ReadonlyMap<string, StylesheetRule | null>;
type FallbackIndex = ReadonlyMap<string, readonly StylesheetRule[] | null>;

export interface ParsedStylesheet {
  readonly uri: string;
  readonly syntax: StylesheetSyntax;
  readonly document: SourceDocument;
  readonly rules: readonly StylesheetRule[];
  readonly pathIndex: RuleIndex;
  readonly fallbackIndex: FallbackIndex;
  readonly fallbackMediaIndex: FallbackIndex;
}

const FALLBACK_BUCKET_LIMIT = 32;
const FALLBACK_ENTRY_LIMIT = INSPECT_LIMITS.cssRules * 2;

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
  stylesheet: ParsedStylesheet,
  fact: CssRuleFact,
  document: SourceDocument,
): StylesheetRule[] {
  if (fact.source !== undefined) {
    if (!validSourcePosition(fact.source.line, fact.source.column)) return [];
    const offset = document.offsetAt({
      line: fact.source.line - 1,
      character: fact.source.column - 1,
    });
    const smallest = smallestRule(stylesheet.rules.filter(
      (rule) => rule.startOffset <= offset && offset < rule.endOffset,
    ));
    return smallest ? [smallest] : [];
  }

  if (Object.prototype.hasOwnProperty.call(fact.metadata, "rulePath")) {
    const browserPath = parseBrowserRulePath(fact.metadata.rulePath);
    if (browserPath === undefined) return [];
    const rule = stylesheet.pathIndex.get(browserPath);
    return rule ? [rule] : [];
  }

  const selector = fallbackSelectorKey(fact.selector);
  if (selector === undefined) return [];
  const media = factMedia(fact);
  if (media === null) return [];
  const bucket = media === undefined
    ? stylesheet.fallbackIndex.get(selector)
    : stylesheet.fallbackMediaIndex.get(fallbackMediaKey(selector, media));
  return bucket ? [...bucket] : [];
}

export function smallestContainingRule(
  rules: readonly StylesheetRule[],
  offset: number,
): StylesheetRule | undefined {
  return smallestRule(rules.filter(
    (rule) => rule.startOffset <= offset && offset < rule.endOffset,
  ));
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
  const rules: StylesheetRule[] = [];
  const rulesByNode = new Map<Rule, StylesheetRule>();
  root.walkRules((node) => {
    const rule = ruleFromNode(node, document);
    if (!rule) return;
    rules.push(rule);
    rulesByNode.set(node, rule);
  });

  if (syntax === "scss") {
    return emptyIndexedStylesheet(document, syntax, rules);
  }

  const indexes = new CssomIndexBuilder(rulesByNode);
  indexes.index(root);
  return {
    uri: document.uri,
    syntax,
    document,
    rules,
    pathIndex: indexes.pathIndex,
    fallbackIndex: indexes.fallbackIndex,
    fallbackMediaIndex: indexes.fallbackMediaIndex,
  };
}

function emptyIndexedStylesheet(
  document: SourceDocument,
  syntax: StylesheetSyntax,
  rules: readonly StylesheetRule[],
): ParsedStylesheet {
  return {
    uri: document.uri,
    syntax,
    document,
    rules,
    pathIndex: new Map(),
    fallbackIndex: new Map(),
    fallbackMediaIndex: new Map(),
  };
}

function ruleFromNode(
  node: Rule,
  document: SourceDocument,
): StylesheetRule | undefined {
  const start = node.source?.start?.offset;
  const end = node.source?.end?.offset;
  if (start === undefined || end === undefined || end <= start) {
    return undefined;
  }
  return {
    selector: node.selector,
    range: {
      start: document.positionAt(start),
      end: document.positionAt(end),
    },
    startOffset: start,
    endOffset: end,
  };
}

type ContainerContext = "rules" | "keyframes";
type RootPhase = "imports" | "namespaces" | "body";

interface AtRuleClassification {
  readonly kind: "count" | "drop" | "uncertain";
  readonly childContext?: ContainerContext;
  readonly recurse?: boolean;
}

// Deliberately limited to rule types used by the read-only MVP. New or
// feature-gated CSSOM rule types fail closed until a browser parity fixture is
// added here.
const GROUP_AT_RULES = new Set([
  "container",
  "layer",
  "media",
  "scope",
  "starting-style",
  "supports",
]);
const LEAF_AT_RULES = new Set([
  "color-profile",
  "counter-style",
  "font-face",
  "font-feature-values",
  "font-palette-values",
  "page",
  "property",
  "view-transition",
]);
const KEYFRAMES_AT_RULES = new Set(["keyframes", "-webkit-keyframes"]);

class CssomIndexBuilder {
  public readonly pathIndex = new Map<string, StylesheetRule | null>();
  public readonly fallbackIndex: FallbackIndex;
  public readonly fallbackMediaIndex: FallbackIndex;

  private readonly selectorValidity = new Map<Rule, boolean>();
  private readonly fallback = new FallbackIndexBuilder();
  private visitedRules = 0;

  public constructor(
    private readonly rulesByNode: ReadonlyMap<Rule, StylesheetRule>,
  ) {
    this.fallbackIndex = this.fallback.selectorIndex;
    this.fallbackMediaIndex = this.fallback.mediaIndex;
  }

  public index(root: Root): void {
    this.indexContainer(root, [], undefined, "rules", true, 0);
  }

  private indexContainer(
    container: Container,
    parentPath: readonly number[],
    owner: Rule | undefined,
    context: ContainerContext,
    inheritedTrusted: boolean,
    depth: number,
  ): void {
    let pathTrusted = inheritedTrusted;
    let cssomIndex = 0;
    let cssRuleSeen = container.type !== "rule";
    let declarationsPending = false;
    let rootPhase: RootPhase = "imports";
    const isRoot = container.type === "root" || container.type === "document";

    const flushDeclarations = (): void => {
      if (!declarationsPending || !owner) return;
      const path = [...parentPath, cssomIndex];
      const withinBudget = this.visitRule();
      if (pathTrusted && withinBudget) {
        this.addPath(path, owner);
      }
      const rule = this.rulesByNode.get(owner);
      if (rule) {
        this.fallback.add(rule, containingMediaFrom(container));
      }
      cssomIndex += 1;
      declarationsPending = false;
    };

    const markUncertain = (): void => {
      pathTrusted = false;
      declarationsPending = false;
      cssRuleSeen = true;
      if (isRoot) rootPhase = "body";
    };

    for (const node of container.nodes ?? []) {
      if (node.type === "decl") {
        if (owner && cssRuleSeen) declarationsPending = true;
        continue;
      }
      if (node.type === "comment") continue;

      if (node.type === "rule") {
        if (context === "keyframes") {
          flushDeclarations();
          this.visitRule();
          cssomIndex += 1;
          cssRuleSeen = true;
          continue;
        }
        if (!this.validSelector(node)) {
          markUncertain();
          continue;
        }

        flushDeclarations();
        if (isRoot) rootPhase = "body";
        const path = [...parentPath, cssomIndex];
        const withinBudget = this.visitRule();
        const rule = this.rulesByNode.get(node);
        if (rule) {
          this.fallback.add(rule, containingMedia(node));
          if (pathTrusted && withinBudget) this.addPath(path, node);
        } else {
          pathTrusted = false;
        }
        cssomIndex += 1;
        cssRuleSeen = true;
        if (depth < INSPECT_LIMITS.cssRuleDepth) {
          this.indexContainer(
            node,
            path,
            node,
            "rules",
            pathTrusted && withinBudget,
            depth + 1,
          );
        }
        continue;
      }

      if (node.type !== "atrule") {
        markUncertain();
        continue;
      }

      const classification = classifyAtRule(
        node,
        isRoot,
        rootPhase,
        owner !== undefined,
      );
      if (classification.kind === "drop") continue;
      if (classification.kind === "uncertain") {
        markUncertain();
        continue;
      }

      flushDeclarations();
      const name = node.name.toLowerCase();
      if (isRoot) {
        rootPhase = name === "import"
          ? rootPhase
          : name === "namespace"
            ? "namespaces"
            : "body";
      }
      const path = [...parentPath, cssomIndex];
      const withinBudget = this.visitRule();
      cssomIndex += 1;
      cssRuleSeen = true;
      if (
        classification.recurse &&
        node.nodes &&
        depth < INSPECT_LIMITS.cssRuleDepth
      ) {
        this.indexContainer(
          node,
          path,
          owner,
          classification.childContext ?? "rules",
          pathTrusted && withinBudget,
          depth + 1,
        );
      }
    }
    flushDeclarations();
  }

  private validSelector(rule: Rule): boolean {
    const cached = this.selectorValidity.get(rule);
    if (cached !== undefined) return cached;
    const selector = rule.selector;
    let valid = selector.length > 0 &&
      selector.length <= INSPECT_LIMITS.selectorLength;
    if (valid) {
      try {
        const root = selectorParser().astSync(selector);
        valid = root.nodes.length > 0 &&
          root.nodes.every((entry) => entry.nodes.length > 0);
      } catch {
        valid = false;
      }
    }
    this.selectorValidity.set(rule, valid);
    return valid;
  }

  private visitRule(): boolean {
    const withinBudget = this.visitedRules < INSPECT_LIMITS.cssRules;
    this.visitedRules += 1;
    return withinBudget;
  }

  private addPath(path: readonly number[], node: Rule): void {
    const rule = this.rulesByNode.get(node);
    if (!rule) return;
    const key = path.join(".");
    if (this.pathIndex.has(key)) {
      this.pathIndex.set(key, null);
      return;
    }
    this.pathIndex.set(key, rule);
  }
}

class FallbackIndexBuilder {
  public readonly selectorIndex = new Map<
    string,
    readonly StylesheetRule[] | null
  >();
  public readonly mediaIndex = new Map<
    string,
    readonly StylesheetRule[] | null
  >();

  private entries = 0;
  private disabled = false;

  public add(rule: StylesheetRule, media: readonly string[]): void {
    if (this.disabled) return;
    const selector = fallbackSelectorKey(rule.selector);
    if (selector === undefined) return;
    this.addToIndex(this.selectorIndex, selector, rule);
    this.addToIndex(
      this.mediaIndex,
      fallbackMediaKey(selector, media.map(normalizeMedia)),
      rule,
    );
  }

  private addToIndex(
    index: Map<string, readonly StylesheetRule[] | null>,
    key: string,
    rule: StylesheetRule,
  ): void {
    if (this.disabled) return;
    const bucket = index.get(key);
    if (bucket === null || bucket?.includes(rule)) return;
    this.entries += 1;
    if (this.entries > FALLBACK_ENTRY_LIMIT) {
      this.disabled = true;
      this.selectorIndex.clear();
      this.mediaIndex.clear();
      return;
    }
    if (bucket && bucket.length >= FALLBACK_BUCKET_LIMIT) {
      index.set(key, null);
      return;
    }
    index.set(key, bucket ? [...bucket, rule] : [rule]);
  }
}

function classifyAtRule(
  rule: AtRule,
  isRoot: boolean,
  rootPhase: RootPhase,
  nestedInStyle: boolean,
): AtRuleClassification {
  const name = rule.name.toLowerCase();
  const hasBlock = rule.nodes !== undefined;
  const hasParameters = rule.params.trim().length > 0;
  if (name === "charset") return { kind: "drop" };
  if (name === "import") {
    return !hasBlock && hasParameters && isRoot && rootPhase === "imports"
      ? { kind: "count" }
      : { kind: "uncertain" };
  }
  if (name === "namespace") {
    return !hasBlock && hasParameters && isRoot && rootPhase !== "body"
      ? { kind: "count" }
      : { kind: "uncertain" };
  }
  if (GROUP_AT_RULES.has(name)) {
    if (!hasBlock && !(name === "layer" && hasParameters)) {
      return { kind: "uncertain" };
    }
    return { kind: "count", recurse: true, childContext: "rules" };
  }
  if (KEYFRAMES_AT_RULES.has(name)) {
    return nestedInStyle || !hasBlock || !hasParameters
      ? { kind: "uncertain" }
      : { kind: "count", recurse: true, childContext: "keyframes" };
  }
  if (LEAF_AT_RULES.has(name)) {
    return nestedInStyle || !hasBlock
      ? { kind: "uncertain" }
      : { kind: "count" };
  }
  return { kind: "uncertain" };
}

function validSourcePosition(line: number, column: number): boolean {
  return Number.isSafeInteger(line) &&
    Number.isSafeInteger(column) &&
    line >= 1 &&
    column >= 1;
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

function fallbackSelectorKey(selector: string): string | undefined {
  if (selector.length === 0 || selector.length > INSPECT_LIMITS.selectorLength) {
    return undefined;
  }
  const key = normalizeSelector(selector);
  return key.length > 0 ? key : undefined;
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

function fallbackMediaKey(
  selector: string,
  media: readonly string[],
): string {
  return JSON.stringify([selector, media]);
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
    if (
      current.type === "atrule" &&
      (current as AtRule).name.toLowerCase() === "media"
    ) {
      media.unshift(normalizeMedia((current as AtRule).params));
    }
    current = current.parent;
  }
  return media;
}

function normalizeMedia(value: string): string {
  return value.trim();
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
