import type { ProtocolErrorCode } from "@browser2ide/protocol";
import type { BrowserConnectionState } from "./bridgeClient.js";

export interface PanelErrorSummary {
  readonly code?: ProtocolErrorCode;
  readonly message: string;
}

export interface PanelDiagnosticsSnapshot {
  readonly connectionState: BrowserConnectionState;
  readonly paired: boolean;
  readonly lastMessageSentAt?: Date;
  readonly lastError?: PanelErrorSummary;
  readonly inaccessibleStylesheetCount: number;
  readonly matchedCssFactCount: number;
}

export class PanelDiagnostics {
  private connectionState: BrowserConnectionState = "disconnected";
  private paired = false;
  private lastMessageSentAt: Date | undefined;
  private lastError: PanelErrorSummary | undefined;
  private inaccessibleStylesheetCount = 0;
  private matchedCssFactCount = 0;

  public setConnectionState(state: BrowserConnectionState): void {
    this.connectionState = state;
  }

  public setPaired(paired: boolean): void {
    this.paired = paired;
  }

  public recordSelection(
    targets: readonly {
      readonly facts: readonly { readonly type?: unknown }[];
    }[],
    inaccessibleStylesheetCount: number,
  ): void {
    this.matchedCssFactCount = targets.flatMap((target) => target.facts).filter(
      (fact) => fact.type === "css-rule",
    ).length;
    this.inaccessibleStylesheetCount = inaccessibleStylesheetCount;
  }

  public recordMessageSent(at = new Date()): void {
    this.lastMessageSentAt = at;
  }

  public recordError(error: PanelErrorSummary): void {
    this.lastError = { ...error };
  }

  public snapshot(): PanelDiagnosticsSnapshot {
    return {
      connectionState: this.connectionState,
      paired: this.paired,
      lastMessageSentAt: this.lastMessageSentAt,
      lastError: this.lastError,
      inaccessibleStylesheetCount: this.inaccessibleStylesheetCount,
      matchedCssFactCount: this.matchedCssFactCount,
    };
  }
}
