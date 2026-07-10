import type * as vscode from "vscode";
import type {
  InspectMessage,
  RuntimeFact,
  SourceReference,
} from "@browser2ide/protocol";

export type ResolvedReference = SourceReference & {
  workspaceUri?: vscode.Uri;
  resolvedRange?: vscode.Range;
  diagnostics: string[];
};

export interface ResolveInput {
  readonly message: InspectMessage;
  readonly facts: readonly RuntimeFact[];
}

export interface SourceResolver {
  readonly id: string;
  readonly supportedFactKinds: readonly string[];
  resolve(input: ResolveInput): Promise<ResolvedReference[]>;
}
