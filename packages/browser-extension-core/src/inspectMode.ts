import type { MatchableElement } from "./collectCssFacts.js";
import type { ElementSnapshotSource } from "./elementSnapshot.js";

export type InspectableElement = ElementSnapshotSource & MatchableElement & {
  readonly parentElement: InspectableElement | null;
};

export interface InspectClickEvent {
  readonly target: unknown;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
}

export interface InspectDocument {
  addEventListener(
    type: "click",
    listener: (event: InspectClickEvent) => void,
    capture: boolean,
  ): void;
  removeEventListener(
    type: "click",
    listener: (event: InspectClickEvent) => void,
    capture: boolean,
  ): void;
}

export interface InspectModeOptions {
  readonly document: InspectDocument;
  readonly onSelect: (element: InspectableElement) => void | Promise<void>;
  readonly onError?: (error: unknown) => void;
}

export class InspectMode {
  private enabled = false;
  private readonly handleClick = (event: InspectClickEvent): void => {
    if (!isInspectableElement(event.target)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    void Promise.resolve(this.options.onSelect(event.target)).catch((error) =>
      this.options.onError?.(error),
    );
  };

  public constructor(private readonly options: InspectModeOptions) {}

  public enable(): void {
    if (this.enabled) {
      return;
    }
    this.enabled = true;
    this.options.document.addEventListener("click", this.handleClick, true);
  }

  public disable(): void {
    if (!this.enabled) {
      return;
    }
    this.enabled = false;
    this.options.document.removeEventListener("click", this.handleClick, true);
  }

  public dispose(): void {
    this.disable();
  }
}

function isInspectableElement(value: unknown): value is InspectableElement {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<InspectableElement>;
  return (
    typeof candidate.tagName === "string" &&
    typeof candidate.id === "string" &&
    candidate.classList !== undefined &&
    candidate.attributes !== undefined &&
    typeof candidate.matches === "function" &&
    (candidate.parentElement === null ||
      typeof candidate.parentElement === "object")
  );
}
