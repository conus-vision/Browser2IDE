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
import type { SourceResolution } from "./sourcePlugins/types.js";

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
  readonly pairingAvailable: boolean;
  readonly pairingExpiresAt?: Date;
  readonly lastInspectAt?: Date;
  readonly targetsReceived: number;
  readonly factsReceived: number;
  readonly matchesResolved: number;
  readonly pluginDiagnostics: number;
  readonly lastProtocolError?: ProtocolErrorSummary;
}

export interface DiagnosticsTrackerOptions {
  readonly now?: () => Date;
}

export class DiagnosticsTracker {
  private readonly now: () => Date;
  private lastInspectAt: Date | undefined;
  private targetsReceived = 0;
  private factsReceived = 0;
  private matchesResolved = 0;
  private pluginDiagnostics = 0;
  private lastProtocolError: ProtocolErrorSummary | undefined;

  public constructor(options: DiagnosticsTrackerOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  public recordInspect(message: InspectMessage): void {
    this.lastInspectAt = this.now();
    this.targetsReceived = message.targets.length;
    this.factsReceived = message.targets.reduce(
      (total, target) => total + target.facts.length,
      0,
    );
    this.matchesResolved = 0;
    this.pluginDiagnostics = 0;
  }

  public recordResolution(resolution: SourceResolution): void {
    this.matchesResolved = resolution.matches.length;
    this.pluginDiagnostics = resolution.diagnostics.length;
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
      pairingAvailable: bridge.pairingCode !== undefined,
      pairingExpiresAt: bridge.pairingExpiresAt,
      lastInspectAt: this.lastInspectAt,
      targetsReceived: this.targetsReceived,
      factsReceived: this.factsReceived,
      matchesResolved: this.matchesResolved,
      pluginDiagnostics: this.pluginDiagnostics,
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
    `pairing=${snapshot.pairingAvailable ? "available" : "unavailable"} expires=${formatDate(snapshot.pairingExpiresAt)}`,
  );
  output.appendLine(
    `lastInspect=${formatDate(snapshot.lastInspectAt)} targets=${snapshot.targetsReceived} facts=${snapshot.factsReceived}`,
  );
  output.appendLine(
    `sources matches=${snapshot.matchesResolved} pluginDiagnostics=${snapshot.pluginDiagnostics}`,
  );
  output.appendLine(
    `protocolError=${snapshot.lastProtocolError ? `${snapshot.lastProtocolError.code}: ${snapshot.lastProtocolError.message}` : "none"}`,
  );
}

function formatDate(value: Date | undefined): string {
  return value?.toISOString() ?? "unavailable";
}
