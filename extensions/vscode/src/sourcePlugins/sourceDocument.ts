import type { SourceDocument } from "@browser2ide/plugin-api";

export interface TextDocumentLike {
  readonly uri: { toString(): string };
  readonly languageId: string;
  readonly version: number;
  getText(): string;
  positionAt(offset: number): { line: number; character: number };
  offsetAt(position: { line: number; character: number }): number;
}

export function adaptSourceDocument(
  document: TextDocumentLike,
): SourceDocument {
  return {
    uri: document.uri.toString(),
    languageId: document.languageId,
    version: document.version,
    getText: () => document.getText(),
    positionAt: (offset) => document.positionAt(offset),
    offsetAt: (position) => document.offsetAt(position),
  };
}
