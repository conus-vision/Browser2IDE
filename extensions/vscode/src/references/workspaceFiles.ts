import type * as vscode from "vscode";

export interface WorkspaceFileApi {
  findFiles(pattern: string): Promise<readonly vscode.Uri[]>;
  readFile(uri: vscode.Uri): Promise<Uint8Array>;
}

export interface TextPosition {
  readonly line: number;
  readonly character: number;
}

export interface RuleTextRange {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly start: TextPosition;
  readonly end: TextPosition;
}

let defaultWorkspaceApi: Promise<WorkspaceFileApi> | undefined;

export async function findWorkspaceFileByUrl(
  url: string,
  api?: WorkspaceFileApi,
): Promise<vscode.Uri | undefined> {
  const workspacePath = workspacePathFromUrl(url);
  if (!workspacePath) {
    return undefined;
  }

  const workspace = api ?? (await getDefaultWorkspaceApi());
  const matches = await workspace.findFiles(`**/${escapeGlobPath(workspacePath)}`);
  return matches[0];
}

export async function findWorkspaceFilesByBasename(
  basename: string,
  api?: WorkspaceFileApi,
): Promise<readonly vscode.Uri[]> {
  if (!basename || basename.includes("/") || basename.includes("\\")) {
    return [];
  }

  const workspace = api ?? (await getDefaultWorkspaceApi());
  return workspace.findFiles(`**/${escapeGlobPath(basename)}`);
}

export async function readText(
  uri: vscode.Uri,
  api?: WorkspaceFileApi,
): Promise<string> {
  const workspace = api ?? (await getDefaultWorkspaceApi());
  return new TextDecoder().decode(await workspace.readFile(uri));
}

export function findRuleRangeBySelector(
  text: string,
  selector: string,
): RuleTextRange | undefined {
  const target = normalizeSelector(selector);
  if (!target) {
    return undefined;
  }

  let boundary = 0;
  let index = 0;

  while (index < text.length) {
    const skipped = skipCommentOrString(text, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }

    const character = text[index];
    if (character === "{" && text[index - 1] === "#") {
      const interpolationEnd = findMatchingBrace(text, index);
      if (interpolationEnd === undefined) {
        return undefined;
      }
      index = interpolationEnd + 1;
      continue;
    }
    if (character === "{") {
      const rawPrelude = text.slice(boundary, index);
      const normalizedPrelude = normalizeSelector(rawPrelude);
      if (selectorMatches(normalizedPrelude, target)) {
        const closingBrace = findMatchingBrace(text, index);
        if (closingBrace === undefined) {
          return undefined;
        }

        const startOffset = findPreludeStart(text, boundary, index);
        const endOffset = closingBrace + 1;
        return {
          startOffset,
          endOffset,
          start: offsetToPosition(text, startOffset),
          end: offsetToPosition(text, endOffset),
        };
      }

      boundary = index + 1;
    } else if (character === ";" || character === "}") {
      boundary = index + 1;
    }

    index += 1;
  }

  return undefined;
}

async function getDefaultWorkspaceApi(): Promise<WorkspaceFileApi> {
  defaultWorkspaceApi ??= import("vscode").then(({ workspace }) => ({
    findFiles: async (pattern: string) =>
      workspace.findFiles(pattern, "**/{node_modules,.git}/**"),
    readFile: async (uri: vscode.Uri) => workspace.fs.readFile(uri),
  }));
  return defaultWorkspaceApi;
}

function workspacePathFromUrl(value: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(value, "http://browser2ide.local").pathname;
  } catch {
    return undefined;
  }

  try {
    return decodeURIComponent(pathname).replace(/^\/+/, "").replace(/\\/g, "/");
  } catch {
    return undefined;
  }
}

function escapeGlobPath(value: string): string {
  return value.replace(/([\[\]{}*?])/g, "[$1]");
}

function normalizeSelector(value: string): string {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|\s)\/\/[^\r\n]*/g, "$1")
    .trim()
    .replace(/\s+/g, " ");
}

function selectorMatches(candidate: string, target: string): boolean {
  return (
    candidate === target ||
    candidate.split(",").some((part) => part.trim() === target)
  );
}

function findMatchingBrace(text: string, openingBrace: number): number | undefined {
  let depth = 0;
  let index = openingBrace;

  while (index < text.length) {
    const skipped = skipCommentOrString(text, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }

    if (text[index] === "{") {
      depth += 1;
    } else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
    index += 1;
  }

  return undefined;
}

function findPreludeStart(text: string, start: number, end: number): number {
  let cursor = start;

  while (cursor < end) {
    if (/\s/.test(text[cursor])) {
      cursor += 1;
      continue;
    }
    if (text[cursor] === "/" && text[cursor + 1] === "*") {
      const commentEnd = text.indexOf("*/", cursor + 2);
      cursor = commentEnd === -1 ? end : commentEnd + 2;
      continue;
    }
    if (text[cursor] === "/" && text[cursor + 1] === "/") {
      const commentEnd = text.indexOf("\n", cursor + 2);
      cursor = commentEnd === -1 ? end : commentEnd + 1;
      continue;
    }
    break;
  }

  return cursor;
}

function skipCommentOrString(text: string, index: number): number {
  const character = text[index];
  const next = text[index + 1];

  if (character === "/" && next === "*") {
    const end = text.indexOf("*/", index + 2);
    return end === -1 ? text.length : end + 2;
  }
  if (character === "/" && next === "/") {
    const end = text.indexOf("\n", index + 2);
    return end === -1 ? text.length : end + 1;
  }
  if (character !== '"' && character !== "'") {
    return index;
  }

  let cursor = index + 1;
  while (cursor < text.length) {
    if (text[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (text[cursor] === character) {
      return cursor + 1;
    }
    cursor += 1;
  }

  return text.length;
}

function offsetToPosition(text: string, offset: number): TextPosition {
  let line = 0;
  let character = 0;

  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      character = 0;
    } else {
      character += 1;
    }
  }

  return { line, character };
}
