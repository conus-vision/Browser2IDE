import type {
  ErrorMessage,
  InspectMessage,
  ProtocolErrorCode,
} from "@browser2ide/protocol";
import type { ConnectionState } from "./bridgeClient.js";
import type {
  BridgeManagerState,
  BridgeSnapshot,
} from "./bridgeManager.js";
import type { ResolvedReference } from "./references/sourceTypes.js";

export interface OutputChannelLike {
  appendLine(value: string): void;
  show(preserveFocus?: boolean): void;
}

export interface ProtocolErrorSummary {
  readonly code: ProtocolErrorCode;
  readonly message: string;
}

export interface DiagnosticsSnapshot {
  readonly bridgeState: BridgeManagerState;
  readonly clientState: ConnectionState;
  readonly url?: string;
  readonly sessionId: string;
  readonly pairingCode?: string;
  readonly pairingExpiresAt?: Date;
  readonly lastInspectAt?: Date;
  readonly factsReceived: number;
  readonly referencesResolved: number;
  readonly unmappedSources: readonly string[];
  readonly externalCssCount: number;
  readonly lastProtocolError?: ProtocolErrorSummary;
}

export interface DiagnosticsTrackerOptions {
  readonly now?: () => Date;
}

export class DiagnosticsTracker {
  private readonly now: () => Date;
  private lastInspectAt: Date | undefined;
  private factsReceived = 0;
  private referencesResolved = 0;
  private unmappedSources: string[] = [];
  private externalCssCount = 0;
  private lastProtocolError: ProtocolErrorSummary | undefined;

  public constructor(options: DiagnosticsTrackerOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  public recordInspect(message: InspectMessage): void {
    this.lastInspectAt = this.now();
    this.factsReceived = message.targets.reduce(
      (total, target) => total + target.facts.length,
      0,
    );
  }

  public recordReferences(references: readonly ResolvedReference[]): void {
    this.referencesResolved = references.length;
    this.unmappedSources = [
      ...new Set(
        references
          .filter((reference) => reference.status === "unmapped")
          .map((reference) => reference.source.uri),
      ),
    ];
    this.externalCssCount = references.filter(
      (reference) =>
        reference.kind === "style-rule" && reference.status === "external",
    ).length;
  }

  public recordProtocolError(error: ErrorMessage): void {
    this.lastProtocolError = { code: error.code, message: error.message };
  }

  public snapshot(
    bridge: BridgeSnapshot,
    clientState: ConnectionState,
  ): DiagnosticsSnapshot {
    return {
      bridgeState: bridge.state,
      clientState,
      url: bridge.url,
      sessionId: bridge.sessionId,
      pairingCode: bridge.pairingCode,
      pairingExpiresAt: bridge.pairingExpiresAt,
      lastInspectAt: this.lastInspectAt,
      factsReceived: this.factsReceived,
      referencesResolved: this.referencesResolved,
      unmappedSources: [...this.unmappedSources],
      externalCssCount: this.externalCssCount,
      lastProtocolError: this.lastProtocolError,
    };
  }
}

export function writeBridgeDiagnostics(
  output: OutputChannelLike,
  snapshot: DiagnosticsSnapshot,
): void {
  output.appendLine(
    `bridge=${snapshot.bridgeState} client=${snapshot.clientState} url=${snapshot.url ?? "unavailable"} session=${snapshot.sessionId}`,
  );
  output.appendLine(
    `pairing=${snapshot.pairingCode ?? "unavailable"} expires=${formatDate(snapshot.pairingExpiresAt)}`,
  );
  output.appendLine(
    `lastInspect=${formatDate(snapshot.lastInspectAt)} facts=${snapshot.factsReceived}`,
  );
  output.appendLine(
    `references=${snapshot.referencesResolved} unmapped=${snapshot.unmappedSources.join(",") || "none"} externalCss=${snapshot.externalCssCount}`,
  );
  output.appendLine(
    `protocolError=${snapshot.lastProtocolError ? `${snapshot.lastProtocolError.code}: ${snapshot.lastProtocolError.message}` : "none"}`,
  );
}

function formatDate(value: Date | undefined): string {
  return value?.toISOString() ?? "unavailable";
}
