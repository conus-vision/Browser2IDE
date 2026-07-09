import type { BridgeSnapshot } from "./bridgeManager.js";
import type { ConnectionState } from "./bridgeClient.js";

export interface OutputChannelLike {
  appendLine(value: string): void;
  show(preserveFocus?: boolean): void;
}

export function writeBridgeDiagnostics(
  output: OutputChannelLike,
  snapshot: BridgeSnapshot,
  clientState: ConnectionState,
): void {
  output.appendLine(`bridge=${snapshot.state} url=${snapshot.url ?? "unavailable"} session=${snapshot.sessionId}`);
  output.appendLine(`pairing=${snapshot.pairingCode ?? "unavailable"} client=${clientState}`);
}
