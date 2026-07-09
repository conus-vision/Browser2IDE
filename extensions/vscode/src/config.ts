import type * as vscode from "vscode";

export interface BridgeConfiguration {
  readonly bridgeUrl: string;
  readonly bridgePort: number;
  readonly sessionId: string;
  readonly openAllReferences: boolean;
}

export function readBridgeConfiguration(
  configuration: Pick<vscode.WorkspaceConfiguration, "get">,
): BridgeConfiguration {
  return {
    bridgeUrl: configuration.get<string>("bridgeUrl", "ws://127.0.0.1:48735"),
    bridgePort: configuration.get<number>("bridgePort", 48_735),
    sessionId: configuration.get<string>("sessionId", "default"),
    openAllReferences: configuration.get<boolean>("openAllReferences", true),
  };
}
