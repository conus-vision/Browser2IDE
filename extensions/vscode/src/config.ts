import type * as vscode from "vscode";

export interface BridgeConfiguration {
  readonly sessionId: string;
}

export function readBridgeConfiguration(
  configuration: Pick<vscode.WorkspaceConfiguration, "get">,
): BridgeConfiguration {
  return {
    sessionId: configuration.get<string>("sessionId", "default"),
  };
}
