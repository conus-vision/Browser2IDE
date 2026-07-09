import * as vscode from "vscode";
import { BridgeClient, type ConnectionState } from "./bridgeClient.js";
import { BridgeManager } from "./bridgeManager.js";
import { readBridgeConfiguration } from "./config.js";
import { writeBridgeDiagnostics } from "./diagnostics.js";

let manager: BridgeManager | undefined;
let client: BridgeClient | undefined;
let clientState: ConnectionState = "disconnected";
let statusBar: vscode.StatusBarItem | undefined;
let output: vscode.OutputChannel | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("Browser2IDE");
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  statusBar.show();
  updateStatus("disconnected");

  const configuration = readBridgeConfiguration(
    vscode.workspace.getConfiguration("browser2ide"),
  );
  manager = new BridgeManager({ configuration, secrets: context.secrets });

  const start = async (): Promise<void> => {
    await manager?.start();
    const snapshot = manager?.snapshot();
    const token = manager?.getIdeToken();
    if (!snapshot?.url || !token || client) {
      return;
    }

    client = new BridgeClient({
      url: snapshot.url,
      sessionId: snapshot.sessionId,
      authToken: token,
    });
    client.onConnectionStateChanged((state) => {
      clientState = state;
      updateStatus(state);
    });
    client.onInspect((message) => output?.appendLine(`inspect ${message.messageId}`));
    client.connect();
  };

  context.subscriptions.push(
    output,
    statusBar,
    vscode.commands.registerCommand("browser2ide.start", async () => {
      try {
        await start();
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand("browser2ide.stop", async () => {
      client?.dispose();
      client = undefined;
      await manager?.stop();
      clientState = "disconnected";
      updateStatus(clientState);
    }),
    vscode.commands.registerCommand("browser2ide.showPairingCode", () => {
      const code = manager?.snapshot().pairingCode;
      void vscode.window.showInformationMessage(
        code ? `Browser2IDE pairing code: ${code}` : "Browser2IDE has no active pairing code.",
      );
    }),
    vscode.commands.registerCommand("browser2ide.resetPairing", async () => {
      await manager?.resetPairing();
      void vscode.window.showInformationMessage("Browser2IDE pairing has been reset.");
    }),
    vscode.commands.registerCommand("browser2ide.openDiagnostics", () => {
      if (output && manager) {
        writeBridgeDiagnostics(output, manager.snapshot(), clientState);
        output.show(true);
      }
    }),
  );

  try {
    await start();
  } catch (error) {
    reportError(error);
  }
}

export async function deactivate(): Promise<void> {
  client?.dispose();
  client = undefined;
  await manager?.stop();
  manager = undefined;
  statusBar?.dispose();
  output?.dispose();
}

function updateStatus(state: ConnectionState): void {
  if (!statusBar) {
    return;
  }

  statusBar.text = {
    disconnected: "Browser2IDE: Offline",
    connecting: "Browser2IDE: Connecting",
    connected: "Browser2IDE: Connected",
    error: "Browser2IDE: Error",
  }[state];
}

function reportError(error: unknown): void {
  clientState = "error";
  updateStatus(clientState);
  output?.appendLine(error instanceof Error ? error.stack ?? error.message : String(error));
}
