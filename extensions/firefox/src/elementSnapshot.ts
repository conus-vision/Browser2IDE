import type { InspectSubject } from "@browser2ide/protocol";

export interface ElementSnapshotSource {
  readonly tagName: string;
  readonly id: string;
  readonly classList: Iterable<string>;
  readonly attributes: Iterable<{ readonly name: string; readonly value: string }>;
}

export function createElementSnapshot(
  element: ElementSnapshotSource,
  pageUrl: string,
): InspectSubject {
  const tag = element.tagName.toLowerCase();
  const classes = [...element.classList].filter(Boolean);
  const id = element.id;
  const attributes = [...element.attributes]
    .filter(({ name }) => isSafeAttribute(name))
    .map(({ name, value }) => ({
      name: name.toLowerCase(),
      value,
      metadata: {},
    }));

  return {
    selector: selectorFor(tag, id, classes),
    ...(id ? { nodeId: id } : {}),
    ...(attributes.length > 0 ? { attributes } : {}),
    metadata: {
      tag,
      id,
      classes,
      pageUrl,
    },
  };
}

function selectorFor(tag: string, id: string, classes: readonly string[]): string {
  return [
    tag || "*",
    id ? `#${escapeCssIdentifier(id)}` : "",
    ...classes.map((className) => `.${escapeCssIdentifier(className)}`),
  ].join("");
}

function isSafeAttribute(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === "role" ||
    normalized.startsWith("data-") ||
    normalized.startsWith("aria-")
  );
}

function escapeCssIdentifier(value: string): string {
  let escaped = "";
  for (const [index, character] of [...value].entries()) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0) {
      escaped += "\uFFFD";
    } else if (value.length === 1 && character === "-") {
      escaped += "\\-";
    } else if (
      (code >= 1 && code <= 31) ||
      code === 127 ||
      (index === 0 && code >= 48 && code <= 57) ||
      (index === 1 && code >= 48 && code <= 57 && value[0] === "-")
    ) {
      escaped += `\\${code.toString(16)} `;
    } else if (
      code >= 128 ||
      character === "-" ||
      character === "_" ||
      /[a-zA-Z0-9]/.test(character)
    ) {
      escaped += character;
    } else {
      escaped += `\\${character}`;
    }
  }
  return escaped;
}
