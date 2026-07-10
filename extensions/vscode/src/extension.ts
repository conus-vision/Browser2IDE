import * as vscode from "vscode";
import { BridgeClient, type ConnectionState } from "./bridgeClient.js";
import { BridgeManager } from "./bridgeManager.js";
import { readBridgeConfiguration } from "./config.js";
import {
  DiagnosticsTracker,
  writeBridgeDiagnostics,
} from "./diagnostics.js";
import { CssRuleResolver } from "./references/cssRuleResolver.js";
import { SourceResolverRegistry } from "./references/sourceResolverRegistry.js";
import type {
  DecorationEditorLike,
} from "./presenter/decorations.js";
import {
  createPresenterRuntime,
  type PresenterRuntime,
  type PresenterRuntimeHost,
} from "./presenter/runtime.js";

let manager: BridgeManager | undefined;
let client: BridgeClient | undefined;
let clientState: ConnectionState = "disconnected";
let statusBar: vscode.StatusBarItem | undefined;
let output: vscode.OutputChannel | undefined;
let presenterRuntime: PresenterRuntime | undefined;
let diagnostics: DiagnosticsTracker | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("Browser2IDE");
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  statusBar.show();
  updateStatus("disconnected");
  diagnostics = new DiagnosticsTracker();

  presenterRuntime = createPresenterRuntime({
    resolver: new SourceResolverRegistry([new CssRuleResolver()]),
    host: createPresenterHost(),
  });
  const diagnosticsTreeSubscription =
    presenterRuntime.tree.onDidChangeTreeData(() => {
      if (presenterRuntime) {
        diagnostics?.recordReferences(presenterRuntime.tree.getReferences());
      }
    });

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
    client.onProtocolError((message) => {
      diagnostics?.recordProtocolError(message);
      output?.appendLine(`protocol error ${message.code}: ${message.message}`);
    });
    client.onInspect((message) => {
      diagnostics?.recordInspect(message);
      output?.appendLine(`inspect ${message.messageId}`);
      const openAll = vscode.workspace
        .getConfiguration("browser2ide")
        .get<boolean>("openAllReferences", true);
      void presenterRuntime?.presenter
        .present(message, openAll)
        .catch(reportError);
    });
    client.connect();
  };

  context.subscriptions.push(
    output,
    statusBar,
    presenterRuntime,
    diagnosticsTreeSubscription,
    vscode.commands.registerCommand("browser2ide.start", async () => {
      try {
        await start();
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand("browser2ide.stop", async () => {
      presenterRuntime?.presenter.cancel();
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
      if (output && manager && diagnostics) {
        writeBridgeDiagnostics(
          output,
          diagnostics.snapshot(manager.snapshot(), clientState),
        );
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
  presenterRuntime?.dispose();
  presenterRuntime = undefined;
  diagnostics = undefined;
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

function createPresenterHost(): PresenterRuntimeHost {
  return {
    createThemeIcon: (id) => new vscode.ThemeIcon(id),
    registerTreeDataProvider: (provider) =>
      vscode.window.registerTreeDataProvider(
        "browser2ide.applicableRules",
        provider,
      ),
    registerCommand: (command, callback) =>
      vscode.commands.registerCommand(command, callback),
    createDecorationType: (options) =>
      vscode.window.createTextEditorDecorationType(options),
    createRange: (startLine, startColumn, endLine, endColumn) =>
      new vscode.Range(startLine, startColumn, endLine, endColumn),
    getVisibleEditors: () =>
      vscode.window.visibleTextEditors.map(decorationEditor),
    onDidChangeVisibleEditors: (listener) =>
      vscode.window.onDidChangeVisibleTextEditors((editors) =>
        listener(editors.map(decorationEditor)),
      ),
    openTextDocument: (uri) => vscode.workspace.openTextDocument(uri),
    showTextDocument: (document, options) =>
      vscode.window.showTextDocument(document as vscode.TextDocument, options),
    revealRange: (editor, range) =>
      (editor as vscode.TextEditor).revealRange(
        range as vscode.Range,
        vscode.TextEditorRevealType.InCenter,
      ),
    reportError,
  };
}

function decorationEditor(editor: vscode.TextEditor): DecorationEditorLike {
  return {
    document: { uri: editor.document.uri },
    setDecorations(decorationType, ranges) {
      editor.setDecorations(
        decorationType as vscode.TextEditorDecorationType,
        ranges as readonly vscode.Range[],
      );
    },
  };
}
