import { createHash } from "node:crypto";
import postcss, {
  type AtRule,
  type ChildNode,
  type Container,
  type Rule,
} from "postcss";
import { parse as parseScss } from "postcss-scss";
import type {
  SourceDocument,
  SourcePosition,
  SourceRange,
} from "@browser2ide/plugin-api";
import type { CssRuleFact } from "@browser2ide/protocol";

export type StylesheetSyntax = "css" | "scss";

export interface StylesheetRule {
  readonly selector: string;
  readonly normalizedSelector: string;
  readonly range: SourceRange;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly media: readonly string[];
  readonly path: string;
}

export interface ParsedStylesheet {
  readonly uri: string;
  readonly syntax: StylesheetSyntax;
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
  const selector = normalizeSelector(fact.selector);
  const media = factMedia(fact);
  const candidates = rules.filter(
    (rule) =>
      rule.normalizedSelector === selector &&
      (media === undefined || sameMedia(rule.media, media)),
  );

  if (fact.source) {
    const offset = document.offsetAt({
      line: fact.source.line - 1,
      character: fact.source.column - 1,
    });
    const containing = candidates.filter(
      (rule) => rule.startOffset <= offset && offset < rule.endOffset,
    );
    const smallest = smallestRule(containing);
    return smallest ? [smallest] : [];
  }

  const rulePath = fact.metadata.rulePath;
  if (typeof rulePath === "string" && rulePath.length > 0) {
    const byPath = candidates.filter(
      (rule) => rulePath === rule.path || rulePath.endsWith(`.${rule.path}`),
    );
    if (byPath.length > 0) return byPath;
  }

  return candidates;
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
  const rules: StylesheetRule[] = [];
  root.walkRules((node) => {
    const rule = ruleFromNode(node, document);
    if (rule) rules.push(rule);
  });
  return { uri: document.uri, syntax, rules };
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
    normalizedSelector: normalizeSelector(node.selector),
    range: {
      start: document.positionAt(start),
      end: document.positionAt(end),
    },
    startOffset: start,
    endOffset: end,
    media: containingMedia(node),
    path: nodePath(node),
  };
}

function containingMedia(node: Rule): readonly string[] {
  const media: string[] = [];
  let parent: Rule["parent"] | undefined = node.parent;
  while (parent) {
    if (parent.type === "atrule" && (parent as AtRule).name === "media") {
      media.unshift(normalizeMedia((parent as AtRule).params));
    }
    parent = parent.parent as Rule["parent"] | undefined;
  }
  return media;
}

function nodePath(node: ChildNode): string {
  const indexes: number[] = [];
  let current: ChildNode | undefined = node;
  while (current?.parent) {
    const parent: Container = current.parent;
    indexes.unshift(parent.index(current));
    current = parent.type === "root" ? undefined : (parent as ChildNode);
  }
  return indexes.join(".");
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
