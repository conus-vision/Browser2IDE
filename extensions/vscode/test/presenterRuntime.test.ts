import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import type { InspectMessage } from "@browser2ide/protocol";
import { createPresenterRuntime } from "../src/presenter/runtime.js";

describe("presenter runtime", () => {
  it("registers presenter surfaces and disposes every owned resource", async () => {
    const disposed: string[] = [];
    const registeredCommands: string[] = [];
    let treeRegistered = false;
    const runtime = createPresenterRuntime({
      resolver: { async resolve() { return []; } },
      host: {
        createThemeIcon: (id) => ({ id }) as vscode.ThemeIcon,
        registerTreeDataProvider() {
          treeRegistered = true;
          return { dispose: () => disposed.push("tree-registration") };
        },
        registerCommand(command) {
          registeredCommands.push(command);
          return { dispose: () => disposed.push("command") };
        },
        createDecorationType() {
          return { dispose: () => disposed.push("decoration") };
        },
        createRange: (...coordinates) => coordinates,
        getVisibleEditors: () => [],
        onDidChangeVisibleEditors() {
          return { dispose: () => disposed.push("visible-listener") };
        },
        async openTextDocument(uri) {
          return { uri };
        },
        async showTextDocument() {
          return {};
        },
        revealRange() {},
        reportError() {},
      },
    });

    await runtime.presenter.present(inspect(), true);
    expect(treeRegistered).toBe(true);
    expect(registeredCommands).toEqual(["browser2ide.openReference"]);

    runtime.dispose();
    expect(disposed).toEqual([
      "tree-registration",
      "command",
      "visible-listener",
      "decoration",
      "decoration",
      "decoration",
    ]);
  });
});

function inspect(): InspectMessage {
  return {
    protocolVersion: 2,
    type: "inspect",
    messageId: "inspect-1",
    sessionId: "session-1",
    source: { role: "browser", id: "browser-1", metadata: {} },
    targets: [
      {
        role: "selected",
        depth: 0,
        subject: { selector: ".card", metadata: {} },
        facts: [],
        metadata: {},
      },
    ],
    context: { url: "http://localhost:3000", metadata: {} },
    metadata: {},
  };
}
