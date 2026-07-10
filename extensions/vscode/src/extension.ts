import * as vscode from "vscode";
import type { Browser2IDEApi } from "@browser2ide/plugin-api";
import { BridgeClient, type ConnectionState } from "./bridgeClient.js";
import { BridgeManager } from "./bridgeManager.js";
import { readBridgeConfiguration } from "./config.js";
import {
  DiagnosticsTracker,
  writeBridgeDiagnostics,
} from "./diagnostics.js";
import { showPairingCode } from "./pairing.js";
import {
  createPresenterRuntime,
  type PresenterEditorLike,
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

export async function activate(
  context: vscode.ExtensionContext,
): Promise<Browser2IDEApi> {
  output = vscode.window.createOutputChannel("Browser2IDE");
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  statusBar.show();
  updateStatus("disconnected");
  diagnostics = new DiagnosticsTracker();

  const runtime = createPresenterRuntime({
    host: createPresenterHost(),
    diagnostics,
  });
  presenterRuntime = runtime;

  const configuration = readBridgeConfiguration(
    vscode.workspace.getConfiguration("browser2ide"),
  );
  manager = new BridgeManager({ configuration, secrets: context.secrets });

  const start = async (): Promise<void> => {
    await manager?.start();
    const snapshot = manager?.snapshot();
    const token = manager?.getIdeToken();
    if (!snapshot?.url || !token || client) return;

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
      runtime.select(message);
    });
    client.connect();
  };

  context.subscriptions.push(
    output,
    statusBar,
    runtime,
    vscode.commands.registerCommand("browser2ide.start", async () => {
      try {
        await start();
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand("browser2ide.stop", async () => {
      runtime.clear();
      client?.dispose();
      client = undefined;
      await manager?.stop();
      clientState = "disconnected";
      updateStatus(clientState);
    }),
    vscode.commands.registerCommand("browser2ide.showPairingCode", async () => {
      await showPairingCode({
        async refreshPairing() {
          try {
            await start();
          } catch (error) {
            reportError(error);
            throw error;
          }
        },
        getPairing() {
          const snapshot = manager?.snapshot();
          return {
            code: snapshot?.pairingCode,
            expiresAt: snapshot?.pairingExpiresAt,
          };
        },
        writeClipboard: (value) => vscode.env.clipboard.writeText(value),
        showInputBox: (options) => vscode.window.showInputBox(options),
        showErrorMessage: (message) => vscode.window.showErrorMessage(message),
      });
    }),
    vscode.commands.registerCommand("browser2ide.resetPairing", async () => {
      await manager?.resetPairing();
      void vscode.window.showInformationMessage(
        "Browser2IDE pairing has been reset.",
      );
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

  return runtime.api;
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
  if (!statusBar) return;
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
  output?.appendLine(
    error instanceof Error ? error.stack ?? error.message : String(error),
  );
}

function createPresenterHost(): PresenterRuntimeHost {
  return {
    get workspaceFolders() {
      return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
        uri: folder.uri,
      }));
    },
    findFiles: (pattern, exclude) => vscode.workspace.findFiles(pattern, exclude),
    parseUri: (value) => vscode.Uri.parse(value),
    readFile: (uri) => vscode.workspace.fs.readFile(uri as vscode.Uri),
    getActiveEditor: () => {
      const editor = vscode.window.activeTextEditor;
      return editor ? presenterEditor(editor) : undefined;
    },
    onDidChangeActiveEditor: (listener) =>
      vscode.window.onDidChangeActiveTextEditor((editor) =>
        listener(editor ? presenterEditor(editor) : undefined),
      ),
    onDidChangeTextDocument: (listener) =>
      vscode.workspace.onDidChangeTextDocument((event) =>
        listener(event.document),
      ),
    createThemeIcon: (id) => new vscode.ThemeIcon(id),
    createThemeColor: (id) => new vscode.ThemeColor(id),
    overviewRulerLaneRight: vscode.OverviewRulerLane.Right,
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
    revealRange: (editor, range) =>
      vscodeEditor(editor).revealRange(
        range as vscode.Range,
        vscode.TextEditorRevealType.InCenter,
      ),
    selectRangeStart: (editor, start) => {
      const position = new vscode.Position(start.line, start.character);
      vscodeEditor(editor).selection = new vscode.Selection(position, position);
    },
    reportError,
  };
}

type VsCodePresenterEditor = PresenterEditorLike & {
  readonly source: vscode.TextEditor;
};

function presenterEditor(editor: vscode.TextEditor): VsCodePresenterEditor {
  return {
    source: editor,
    document: editor.document,
    setDecorations(decorationType, ranges) {
      editor.setDecorations(
        decorationType as vscode.TextEditorDecorationType,
        ranges as readonly vscode.Range[],
      );
    },
  };
}

function vscodeEditor(editor: PresenterEditorLike): vscode.TextEditor {
  return (editor as VsCodePresenterEditor).source;
}
