# Browser2IDE Source Plugin System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the resolve-all CSS presenter with protocol v2, a public document-first source plugin API, production CSS/SCSS plugins, immediate-parent highlighting, and realistic authoring guidance for future source plugins.

**Architecture:** Firefox sends selected and immediate-parent targets over the existing WebSocket bridge. VS Code retains the latest selection, dispatches only plugins compatible with the active document, and applies semantic selected/parent decorations without opening files. Built-in CSS and SCSS implementations use the same versioned API exported to external VS Code extensions.

**Tech Stack:** Node.js 20+, pnpm 9, TypeScript 5.5+, Zod 3, Vitest 2, PostCSS 8.5.16, postcss-scss 4.0.9, source-map 0.7.6, VS Code Extension API, @vscode/test-cli 0.0.15, @vscode/test-electron 3.0.0, Firefox WebExtensions.

---

## Execution Precondition

The current working tree contains a completed pairing-code fix that predates
this feature. Preserve it as a separate checkpoint before creating an isolated
worktree or dispatching implementation tasks. Do not stage the unrelated
untracked `docs/superpowers/plans/2026-07-09-browser2ide-mvp.md` file.

### Task 0: Checkpoint The Existing Pairing Fix

**Files:**
- Modify: `docs/mvp-usage.md`
- Modify: `docs/mvp-verification.md`
- Modify: `extensions/vscode/src/extension.ts`
- Modify: `extensions/vscode/src/pairing.ts`
- Create: `extensions/vscode/test/pairingCodeCommand.test.ts`

- [ ] **Step 1: Verify the existing pairing regression tests**

Run:

```powershell
corepack pnpm --filter browser2ide-vscode test -- pairingCodeCommand.test.ts
corepack pnpm --filter browser2ide-vscode typecheck
```

Expected: 4 pairing command tests pass and TypeScript exits with code 0.

- [ ] **Step 2: Confirm the checkpoint contains only the pairing fix**

Run:

```powershell
git diff -- docs/mvp-usage.md docs/mvp-verification.md extensions/vscode/src/extension.ts extensions/vscode/src/pairing.ts
git status --short
```

Expected: the listed code changes only create/refresh, copy, and persistently
display the pairing code; `pairingCodeCommand.test.ts` is the only new test.

- [ ] **Step 3: Commit the checkpoint without staging the old untracked plan**

```powershell
git add -- docs/mvp-usage.md docs/mvp-verification.md extensions/vscode/src/extension.ts extensions/vscode/src/pairing.ts extensions/vscode/test/pairingCodeCommand.test.ts
git commit -m "fix(vscode): keep pairing code visible"
```

Expected: one commit containing the five pairing-fix paths. The old untracked
MVP plan remains untracked.

## Planned File Structure

New public package:

```text
packages/plugin-api/
  package.json
  tsconfig.json
  src/index.ts
  test/contracts.test.ts
  test/public-export.mjs
```

New VS Code source subsystem:

```text
extensions/vscode/src/sourcePlugins/
  api.ts                    public Browser2IDE API wrapper
  registry.ts               registration, dispatch, timeout, validation
  types.ts                  host-owned resolution result types
  sourceDocument.ts         VS Code TextDocument adapter
  sourceWorkspace.ts        constrained workspace and URI adapter
  cssFacts.ts               target-aware CSS fact grouping
  stylesheetAst.ts          PostCSS/PostCSS-SCSS AST ranges and caches
  cssSourcePlugin.ts        active CSS document resolver
  sourceMapLoader.ts        external/inline map loading and map cache
  scssSourcePlugin.ts       active SCSS document resolver
```

New active-editor presenter:

```text
extensions/vscode/src/presenter/
  selectionStore.ts
  activeEditorCoordinator.ts
  applicableSourcesTree.ts
  decorations.ts            rewritten for selected/parent roles
  commands.ts               rewritten to reveal active-file matches
  runtime.ts                rewritten composition root
```

Firefox target construction:

```text
extensions/firefox/src/inspectPayload.ts
extensions/firefox/test/inspectPayload.test.ts
```

External fixture extension:

```text
extensions/source-plugin-fixture/
  package.json
  tsconfig.json
  esbuild.mjs
  src/extension.ts
```

The old `extensions/vscode/src/references/` directory and
`extensions/vscode/src/presenter/openReferences.ts` are deleted after the new
runtime is wired and its tests are green.

### Task 1: Migrate The Wire Protocol To V2 Targets

**Files:**
- Create: `packages/protocol/src/json.ts`
- Modify: `packages/protocol/src/messages.ts`
- Modify: `packages/protocol/src/schema.ts`
- Modify: `packages/protocol/test/schema.test.ts`
- Modify: `packages/protocol/test/public-export.mjs`
- Modify: `packages/bridge/src/heartbeat.ts`
- Modify: `packages/bridge/src/router.ts`
- Modify: `packages/bridge/src/server.ts`
- Modify: `packages/bridge/test/auth.test.ts`
- Modify: `packages/bridge/test/heartbeat.test.ts`
- Modify: `packages/bridge/test/router.test.ts`
- Modify: `extensions/firefox/src/bridgeClient.ts`
- Modify: `extensions/firefox/src/contentScript.ts`
- Modify: `extensions/firefox/src/panel.ts`
- Modify: `extensions/firefox/test/pairingClient.test.ts`
- Modify: `extensions/vscode/src/bridgeClient.ts`
- Modify: `extensions/vscode/src/diagnostics.ts`
- Modify: `extensions/vscode/src/presenter/openReferences.ts`
- Modify: `extensions/vscode/test/bridgeClient.test.ts`
- Modify: `extensions/vscode/test/cssRuleResolver.test.ts`
- Modify: `extensions/vscode/test/diagnostics.test.ts`
- Modify: `extensions/vscode/test/openReferences.test.ts`
- Modify: `extensions/vscode/test/presenterRuntime.test.ts`
- Modify: `extensions/vscode/test/referenceStore.test.ts`
- Modify: `tools/simulator/src/sendInspect.ts`
- Modify: `tools/simulator/fixtures/inspect-card.json`
- Modify: `tools/simulator/test/sendInspect.test.ts`

- [ ] **Step 1: Write failing protocol v2 target tests**

Add these focused cases to `packages/protocol/test/schema.test.ts` and change
the valid-message table to `protocolVersion: 2`:

```ts
it("parses selected and immediate-parent inspect targets", () => {
  const message = inspectMessage([
    target("selected", 0, ".card", runtimeFacts),
    target("parent", 1, ".layout", runtimeFacts),
  ]);

  expect(parseMessage(message)).toEqual(message);
});

it("accepts a namespaced plugin runtime fact", () => {
  const fact = {
    type: "react.component",
    source: sourceLocation,
    payload: { componentName: "Card" },
    metadata: {},
  };

  expect(parseMessage(inspectMessage([
    target("selected", 0, ".card", [fact]),
  ]))).toMatchObject({ targets: [{ facts: [fact] }] });
});

it.each([
  ["no selected target", [target("parent", 1, ".layout", runtimeFacts)]],
  ["duplicate selected targets", [
    target("selected", 0, ".card", runtimeFacts),
    target("selected", 0, ".featured", runtimeFacts),
  ]],
  ["parent with the wrong depth", [
    target("selected", 0, ".card", runtimeFacts),
    target("parent", 0, ".layout", runtimeFacts),
  ]],
])("rejects %s", (_name, targets) => {
  expect(() => parseMessage(inspectMessage(targets))).toThrow();
});

it("rejects protocol v1", () => {
  expect(() => parseMessage({
    protocolVersion: 1,
    type: "ping",
    messageId: "old-ping",
    sentAt: "2026-07-11T00:00:00.000Z",
    metadata: {},
  })).toThrow();
});
```

Use concrete helpers in the same test file:

```ts
function target(
  role: "selected" | "parent",
  depth: 0 | 1,
  selector: string,
  facts: readonly unknown[],
) {
  return {
    role,
    depth,
    subject: { selector, metadata: {} },
    facts,
    metadata: {},
  };
}

function inspectMessage(targets: readonly unknown[]) {
  return {
    protocolVersion: 2,
    type: "inspect",
    messageId: "inspect-v2",
    sessionId: "session-1",
    source,
    targets,
    context: { url: "http://localhost:3000/", metadata: {} },
    metadata: {},
  };
}
```

- [ ] **Step 2: Run the protocol tests and verify RED**

Run:

```powershell
corepack pnpm --filter @browser2ide/protocol test
```

Expected: FAIL because protocol version 2, `targets`, and namespaced facts are
not accepted.

- [ ] **Step 3: Implement strict JSON values and protocol v2 targets**

Create `packages/protocol/src/json.ts`:

```ts
import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  JsonValueSchema,
);
```

In `messages.ts`, export and use one protocol constant, replace the old inspect
shape, and validate cross-field target rules:

```ts
export const PROTOCOL_VERSION = 2 as const;

const baseMessageSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  messageId: z.string().min(1),
  metadata: metadataSchema,
}).strict();

export const PluginRuntimeFactSchema = z.object({
  type: z.string()
    .max(128)
    .regex(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/),
  source: SourceLocationSchema.optional(),
  payload: JsonObjectSchema,
  metadata: JsonObjectSchema,
}).strict();

export const RuntimeFactSchema = z.union([
  CssRuleFactSchema,
  DomAttributeFactSchema,
  PluginRuntimeFactSchema,
]);

export const InspectTargetSchema = z.object({
  role: z.enum(["selected", "parent"]),
  depth: z.union([z.literal(0), z.literal(1)]),
  subject: InspectSubjectSchema,
  facts: z.array(RuntimeFactSchema),
  metadata: metadataSchema,
}).strict();

export const InspectMessageSchema = baseMessageSchema.extend({
  type: z.literal("inspect"),
  sessionId: z.string().min(1),
  source: ClientSourceSchema,
  targets: z.array(InspectTargetSchema).min(1).max(2),
  context: InspectContextSchema,
}).strict().superRefine((message, context) => {
  const selected = message.targets.filter((target) => target.role === "selected");
  const parents = message.targets.filter((target) => target.role === "parent");
  if (selected.length !== 1 || selected[0]?.depth !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["targets"], message: "inspect requires one selected target at depth 0" });
  }
  if (parents.length > 1 || parents.some((target) => target.depth !== 1)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["targets"], message: "inspect permits one parent target at depth 1" });
  }
});
```

Export `PROTOCOL_VERSION`, `InspectTarget`, `PluginRuntimeFact`, `JsonObject`,
and `JsonValue` through `schema.ts`/`index.ts`.

- [ ] **Step 4: Migrate every producer and fixture to the protocol constant**

Import `PROTOCOL_VERSION` in production message producers and replace every
literal `protocolVersion: 1` with:

```ts
protocolVersion: PROTOCOL_VERSION,
```

Apply that exact change in the three bridge source files, Firefox
`bridgeClient.ts`, VS Code `bridgeClient.ts`, and simulator `sendInspect.ts`.
Change test fixture literals to `2` in all files listed in this task.

Temporarily construct a selected-only target in `contentScript.ts`:

```ts
targets: [{
  role: "selected",
  depth: 0,
  subject: createElementSnapshot(element, pageUrl),
  facts: collection.facts,
  metadata: {},
}],
```

Change `InspectPayload` in Firefox `bridgeClient.ts` to:

```ts
export type InspectPayload = Pick<
  InspectMessage,
  "targets" | "context" | "metadata"
>;
```

Change the temporary old VS Code presenter input to flatten targets until it is
deleted in Task 10:

```ts
facts: message.targets.flatMap((target) => target.facts),
```

Change `tools/simulator/fixtures/inspect-card.json` from top-level `subject`
and `facts` to:

```json
{
  "targets": [
    {
      "role": "selected",
      "depth": 0,
      "subject": {
        "selector": "div#hero.card.featured",
        "nodeId": "hero",
        "metadata": { "kind": "dom-node" }
      },
      "facts": [],
      "metadata": {}
    }
  ],
  "context": {
    "url": "http://localhost:3000/",
    "route": "/",
    "metadata": { "viewport": "desktop" }
  },
  "metadata": { "fixture": "inspect-card" }
}
```

Move the existing CSS facts into that selected target's `facts` array. Update
simulator output to read `inspect.targets[0].subject.selector`.

- [ ] **Step 5: Update diagnostics to count target facts**

Replace direct `message.facts` reads in `extensions/vscode/src/diagnostics.ts`
with:

```ts
this.factsReceived = message.targets.reduce(
  (total, target) => total + target.facts.length,
  0,
);
```

Update Firefox panel payload guards and summaries to locate:

```ts
const selected = payload.targets.find((target) => target.role === "selected");
const factCount = payload.targets.reduce(
  (total, target) => total + target.facts.length,
  0,
);
```

- [ ] **Step 6: Verify the whole monorepo is green**

Run:

```powershell
rg -n "protocolVersion:\s*1|z\.literal\(1\)" packages extensions tools
corepack pnpm build
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
```

Expected: `rg` returns no protocol-v1 literals; all four pnpm commands exit 0.

- [ ] **Step 7: Commit protocol v2 atomically**

```powershell
git add packages/protocol packages/bridge extensions/firefox extensions/vscode tools/simulator
git commit -m "feat(protocol)!: add inspect targets"
```

Include this commit body:

```text
BREAKING CHANGE: protocol v1 inspect subject/facts fields are replaced by
protocol v2 selected/parent targets.
```

### Task 2: Add The Public Plugin API Package

**Files:**
- Create: `packages/plugin-api/package.json`
- Create: `packages/plugin-api/tsconfig.json`
- Create: `packages/plugin-api/src/index.ts`
- Create: `packages/plugin-api/test/contracts.test.ts`
- Create: `packages/plugin-api/test/public-export.mjs`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Write the failing public contract test**

Create `packages/plugin-api/test/contracts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  SOURCE_PLUGIN_API_VERSION,
  type Browser2IDEApi,
  type SourcePlugin,
} from "../src/index.js";

describe("source plugin public contract", () => {
  it("exports API version 1 and accepts a structurally valid plugin", () => {
    const plugin: SourcePlugin = {
      id: "fixture.source",
      displayName: "Fixture Source",
      apiVersion: SOURCE_PLUGIN_API_VERSION,
      documentSelectors: [{ languageId: "fixture", scheme: "file" }],
      supportedFactKinds: ["fixture.source"],
      async resolve() {
        return { matches: [] };
      },
    };
    const api = undefined as unknown as Browser2IDEApi;

    expect(SOURCE_PLUGIN_API_VERSION).toBe(1);
    expect(plugin.id).toBe("fixture.source");
    expectTypeOf(api.registerSourcePlugin).toBeFunction();
  });
});
```

Create `test/public-export.mjs` that imports
`SOURCE_PLUGIN_API_VERSION` from `../dist/index.js` and throws unless it equals
`1`.

- [ ] **Step 2: Run the package test and verify RED**

Run:

```powershell
corepack pnpm --filter @browser2ide/plugin-api test
```

Expected: FAIL because the workspace package does not exist.

- [ ] **Step 3: Create the package manifest and TypeScript config**

Create `packages/plugin-api/package.json`:

```json
{
  "name": "@browser2ide/plugin-api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run && pnpm run build && node test/public-export.mjs",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "lint": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@browser2ide/protocol": "workspace:*"
  }
}
```

Create `packages/plugin-api/tsconfig.json` matching the protocol package:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 4: Implement the complete public API types**

Create `packages/plugin-api/src/index.ts` with these public contracts:

```ts
import type {
  InspectContext,
  InspectTarget,
  JsonObject,
} from "@browser2ide/protocol";

export const SOURCE_PLUGIN_API_VERSION = 1 as const;

export interface Disposable {
  dispose(): void;
}

export interface SourcePosition {
  readonly line: number;
  readonly character: number;
}

export interface SourceRange {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

export interface SourceDocument {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
  getText(): string;
  positionAt(offset: number): SourcePosition;
  offsetAt(position: SourcePosition): number;
}

export interface SourceUriResolution {
  readonly uris: readonly string[];
  readonly status: "exact" | "unique-basename" | "not-found" | "ambiguous";
}

export interface SourceWorkspace {
  findFiles(pattern: string): Promise<readonly string[]>;
  readText(uri: string): Promise<string>;
  resolveSourceUri(sourceUrl: string, baseUrl: string): Promise<SourceUriResolution>;
  resolveRelativeUri(baseUri: string, reference: string): string;
  isWorkspaceUri(uri: string): boolean;
}

export interface SelectionSnapshot {
  readonly sessionId: string;
  readonly messageId: string;
  readonly targets: readonly InspectTarget[];
  readonly context: InspectContext;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface DocumentSelector {
  readonly languageId: string;
  readonly scheme?: string;
}

export type SourceConfidence =
  | "exact"
  | "sourcemap"
  | "instrumented"
  | "heuristic"
  | "unknown";

export interface SourceMatch {
  readonly targetRole: "selected" | "parent";
  readonly range: SourceRange;
  readonly label: string;
  readonly kind: string;
  readonly relation: string;
  readonly confidence: SourceConfidence;
  readonly metadata?: JsonObject;
}

export interface PluginDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: "info" | "warning" | "error";
  readonly metadata?: JsonObject;
}

export interface SourcePluginContext {
  readonly selection: SelectionSnapshot;
  readonly document: SourceDocument;
  readonly workspace: SourceWorkspace;
  readonly signal: AbortSignal;
}

export interface SourcePluginResult {
  readonly matches: readonly SourceMatch[];
  readonly diagnostics?: readonly PluginDiagnostic[];
}

export interface SourcePlugin {
  readonly id: string;
  readonly displayName: string;
  readonly apiVersion: typeof SOURCE_PLUGIN_API_VERSION;
  readonly documentSelectors: readonly DocumentSelector[];
  readonly supportedFactKinds: readonly string[];
  resolve(context: SourcePluginContext): Promise<SourcePluginResult>;
}

export interface Browser2IDEApi {
  readonly apiVersion: typeof SOURCE_PLUGIN_API_VERSION;
  registerSourcePlugin(plugin: SourcePlugin): Disposable;
}
```

- [ ] **Step 5: Install, build, and test the package**

Run:

```powershell
corepack pnpm install
corepack pnpm --filter @browser2ide/plugin-api test
corepack pnpm --filter @browser2ide/plugin-api typecheck
```

Expected: package tests and public export check pass.

- [ ] **Step 6: Commit the public contract**

```powershell
git add packages/plugin-api pnpm-lock.yaml
git commit -m "feat(api): add source plugin contract"
```

### Task 3: Implement Registration And Document-First Dispatch

**Files:**
- Create: `extensions/vscode/src/sourcePlugins/types.ts`
- Create: `extensions/vscode/src/sourcePlugins/registry.ts`
- Create: `extensions/vscode/test/sourcePluginRegistry.test.ts`
- Modify: `extensions/vscode/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add the plugin API dependency**

Add this runtime dependency to `extensions/vscode/package.json`:

```json
"@browser2ide/plugin-api": "workspace:*"
```

Run `corepack pnpm install` so the lockfile records the workspace edge.

- [ ] **Step 2: Write failing registry behavior tests**

Create `sourcePluginRegistry.test.ts` with real plugin objects and fake public
documents. Cover at least these concrete assertions:

```ts
it("dispatches only plugins matching the active document and fact kinds", async () => {
  const registry = new SourcePluginRegistry();
  registry.register(plugin({
    id: "css",
    languageId: "css",
    factKinds: ["css-rule"],
    matches: [match("selected", range(0, 0, 2, 1), "exact")],
  }));
  registry.register(plugin({
    id: "scss",
    languageId: "scss",
    factKinds: ["css-rule"],
    matches: [],
  }));

  const result = await registry.resolve(
    selectionWithFacts("css-rule"),
    document("file:///app.css", "css", ".card {}"),
    workspace(),
    new AbortController().signal,
  );

  expect(result.matches.map((candidate) => candidate.pluginId)).toEqual(["css"]);
});

it("prefers selected and better confidence on the same range", async () => {
  const registry = registryWithMatches([
    match("parent", range(0, 0, 2, 1), "heuristic"),
    match("selected", range(0, 0, 2, 1), "exact"),
  ]);

  const result = await resolveCss(registry);

  expect(result.matches).toHaveLength(1);
  expect(result.matches[0]).toMatchObject({ targetRole: "selected", confidence: "exact" });
});

it("turns exceptions, invalid ranges, and timeout into diagnostics", async () => {
  const registry = new SourcePluginRegistry({ timeoutMs: 10 });
  registry.register(throwingPlugin("broken"));
  registry.register(outOfBoundsPlugin("invalid"));
  registry.register(neverSettlingPlugin("slow"));

  const result = await resolveCss(registry);

  expect(result.matches).toEqual([]);
  expect(result.diagnostics.map((entry) => entry.code).sort()).toEqual([
    "plugin.exception",
    "plugin.invalidRange",
    "plugin.timeout",
  ]);
});
```

The test file must define deterministic helpers rather than mocking the
registry itself.

- [ ] **Step 3: Run the registry test and verify RED**

Run:

```powershell
corepack pnpm --filter browser2ide-vscode test -- sourcePluginRegistry.test.ts
```

Expected: FAIL because `SourcePluginRegistry` does not exist.

- [ ] **Step 4: Define host-owned resolution types**

Create `sourcePlugins/types.ts`:

```ts
import type {
  PluginDiagnostic,
  SourceMatch,
} from "@browser2ide/plugin-api";

export interface ResolvedSourceMatch extends SourceMatch {
  readonly pluginId: string;
}

export interface ResolvedPluginDiagnostic extends PluginDiagnostic {
  readonly pluginId: string;
}

export interface SourceResolution {
  readonly selectionMessageId: string;
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly matches: readonly ResolvedSourceMatch[];
  readonly diagnostics: readonly ResolvedPluginDiagnostic[];
}
```

- [ ] **Step 5: Implement the registry**

Create `sourcePlugins/registry.ts` with:

```ts
export class SourcePluginRegistry {
  private readonly plugins = new Map<string, SourcePlugin>();
  private readonly listeners = new Set<() => void>();
  private readonly timeoutMs: number;

  constructor(options: { readonly timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 2_000;
  }

  register(plugin: SourcePlugin): Disposable {
    if (plugin.apiVersion !== SOURCE_PLUGIN_API_VERSION) {
      throw new Error(`Plugin "${plugin.id}" uses unsupported API version ${plugin.apiVersion}`);
    }
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Source plugin "${plugin.id}" is already registered`);
    }
    this.plugins.set(plugin.id, plugin);
    this.emitChange();
    return {
      dispose: () => {
        if (this.plugins.delete(plugin.id)) this.emitChange();
      },
    };
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  async resolve(
    selection: SelectionSnapshot,
    document: SourceDocument,
    workspace: SourceWorkspace,
    signal: AbortSignal,
  ): Promise<SourceResolution> {
    const factKinds = new Set(selection.targets.flatMap((target) =>
      target.facts.map((fact) => fact.type),
    ));
    const plugins = [...this.plugins.values()].filter((plugin) =>
      matchesDocument(plugin, document) &&
      plugin.supportedFactKinds.some((kind) => factKinds.has(kind)),
    );
    const settled = await Promise.all(
      plugins.map((plugin) => this.resolvePlugin(plugin, selection, document, workspace, signal)),
    );
    const validated = validateMatches(
      settled.flatMap((entry) => entry.matches),
      selection,
      document,
    );
    return {
      selectionMessageId: selection.messageId,
      documentUri: document.uri,
      documentVersion: document.version,
      matches: deduplicateMatches(validated.matches),
      diagnostics: [
        ...settled.flatMap((entry) => entry.diagnostics),
        ...validated.diagnostics,
      ],
    };
  }

  private emitChange(): void {
    for (const listener of this.listeners) listener();
  }
}
```

Implement `resolvePlugin` with an `AbortController`, a two-second
`Promise.race`, exception diagnostics, and generation-signal propagation.
Implement `validateMatches` with a position round trip through
`document.offsetAt()`/`positionAt()` so negative and clamped positions are
rejected and reported as `plugin.invalidRange`. Implement deduplication by
range, kind, and relation with the confidence order from the design and
selected-over-parent tie breaking.

- [ ] **Step 6: Run registry tests and VS Code typecheck**

Run:

```powershell
corepack pnpm --filter browser2ide-vscode test -- sourcePluginRegistry.test.ts
corepack pnpm --filter browser2ide-vscode typecheck
```

Expected: registry tests pass and typecheck exits 0.

- [ ] **Step 7: Commit registry behavior**

```powershell
git add extensions/vscode/src/sourcePlugins extensions/vscode/test/sourcePluginRegistry.test.ts extensions/vscode/package.json pnpm-lock.yaml
git commit -m "feat(vscode): add source plugin registry"
```

### Task 4: Adapt VS Code Documents And Workspace Access

**Files:**
- Create: `extensions/vscode/src/sourcePlugins/sourceDocument.ts`
- Create: `extensions/vscode/src/sourcePlugins/sourceWorkspace.ts`
- Create: `extensions/vscode/test/sourceDocument.test.ts`
- Create: `extensions/vscode/test/sourceWorkspace.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Add concrete tests for document forwarding and URI resolution:

```ts
it("adapts a VS Code text document without exposing vscode types", () => {
  const adapted = adaptSourceDocument(fakeTextDocument({
    uri: "file:///workspace/src/card.scss",
    languageId: "scss",
    version: 7,
    text: ".card {}",
  }));

  expect(adapted).toMatchObject({
    uri: "file:///workspace/src/card.scss",
    languageId: "scss",
    version: 7,
  });
  expect(adapted.positionAt(6)).toEqual({ line: 0, character: 6 });
});

it("resolves an exact URL suffix and rejects ambiguous basenames", async () => {
  const workspace = sourceWorkspace({
    "file:///workspace/public/dist/app.css": "a{}",
    "file:///workspace/packages/demo/app.css": "b{}",
  });

  await expect(workspace.resolveSourceUri(
    "/public/dist/app.css",
    "http://localhost:4173/",
  )).resolves.toEqual({
    uris: ["file:///workspace/public/dist/app.css"],
    status: "exact",
  });
  await expect(workspace.resolveSourceUri(
    "/app.css",
    "http://localhost:4173/",
  )).resolves.toEqual({ uris: [], status: "ambiguous" });
});

it("rejects the same exact suffix in multiple workspace roots", async () => {
  const workspace = sourceWorkspace({
    "file:///workspace-a/public/dist/app.css": "a{}",
    "file:///workspace-b/public/dist/app.css": "b{}",
  });

  await expect(workspace.resolveSourceUri(
    "/public/dist/app.css",
    "http://localhost:4173/",
  )).resolves.toEqual({ uris: [], status: "ambiguous" });
});
```

Also test percent-encoded paths, relative map URIs, non-workspace URIs, and
UTF-8 file reads.

- [ ] **Step 2: Run adapter tests and verify RED**

Run:

```powershell
corepack pnpm --filter browser2ide-vscode test -- sourceDocument.test.ts sourceWorkspace.test.ts
```

Expected: FAIL because both adapters are missing.

- [ ] **Step 3: Implement the document adapter**

Create `sourceDocument.ts`:

```ts
import type { SourceDocument } from "@browser2ide/plugin-api";

export interface TextDocumentLike {
  readonly uri: { toString(): string };
  readonly languageId: string;
  readonly version: number;
  getText(): string;
  positionAt(offset: number): { line: number; character: number };
  offsetAt(position: { line: number; character: number }): number;
}

export function adaptSourceDocument(document: TextDocumentLike): SourceDocument {
  return {
    uri: document.uri.toString(),
    languageId: document.languageId,
    version: document.version,
    getText: () => document.getText(),
    positionAt: (offset) => document.positionAt(offset),
    offsetAt: (position) => document.offsetAt(position),
  };
}
```

- [ ] **Step 4: Implement constrained workspace resolution**

Create `sourceWorkspace.ts` around an injected VS Code host. A unique exact
path-suffix match wins. Basename fallback is returned only when exactly one
workspace file has that basename. Any collision returns `ambiguous` with no
candidate URIs. The public object implements:

```ts
export class VsCodeSourceWorkspace implements SourceWorkspace {
  constructor(private readonly host: WorkspaceHost) {}

  async findFiles(pattern: string): Promise<readonly string[]> {
    return (await this.host.findFiles(pattern, "**/{node_modules,.git}/**"))
      .map((uri) => uri.toString());
  }

  async readText(uri: string): Promise<string> {
    const parsed = this.host.parseUri(uri);
    if (!this.isWorkspaceUri(uri)) throw new Error(`URI is outside the workspace: ${uri}`);
    return new TextDecoder().decode(await this.host.readFile(parsed));
  }

  async resolveSourceUri(sourceUrl: string, baseUrl: string): Promise<SourceUriResolution> {
    const pathname = decodedPathname(sourceUrl, baseUrl);
    const exact = await this.findFiles(`**/${escapeGlob(pathname.replace(/^\/+/, ""))}`);
    if (exact.length === 1) return { uris: exact, status: "exact" };
    if (exact.length > 1) return { uris: [], status: "ambiguous" };
    const basename = pathname.slice(pathname.lastIndexOf("/") + 1);
    const fallback = await this.findFiles(`**/${escapeGlob(basename)}`);
    if (fallback.length === 1) {
      return { uris: fallback, status: "unique-basename" };
    }
    return {
      uris: [],
      status: fallback.length > 1 ? "ambiguous" : "not-found",
    };
  }

  resolveRelativeUri(baseUri: string, reference: string): string {
    return new URL(reference, baseUri).toString();
  }

  isWorkspaceUri(uri: string): boolean {
    return this.host.workspaceFolders.some((folder) =>
      normalizedPath(uri).startsWith(`${normalizedPath(folder.uri.toString()).replace(/\/$/, "")}/`),
    );
  }
}
```

Keep URI/glob helpers private and cover them through the public tests.

- [ ] **Step 5: Verify adapters**

Run:

```powershell
corepack pnpm --filter browser2ide-vscode test -- sourceDocument.test.ts sourceWorkspace.test.ts
corepack pnpm --filter browser2ide-vscode typecheck
```

Expected: all adapter tests pass.

- [ ] **Step 6: Commit adapters**

```powershell
git add extensions/vscode/src/sourcePlugins/sourceDocument.ts extensions/vscode/src/sourcePlugins/sourceWorkspace.ts extensions/vscode/test/sourceDocument.test.ts extensions/vscode/test/sourceWorkspace.test.ts
git commit -m "feat(vscode): adapt source documents"
```

### Task 5: Implement CssSourcePlugin With PostCSS

**Files:**
- Create: `extensions/vscode/src/sourcePlugins/cssFacts.ts`
- Create: `extensions/vscode/src/sourcePlugins/stylesheetAst.ts`
- Create: `extensions/vscode/src/sourcePlugins/cssSourcePlugin.ts`
- Create: `extensions/vscode/test/cssSourcePlugin.test.ts`
- Modify: `extensions/vscode/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Install the parser dependencies**

Run:

```powershell
corepack pnpm --filter browser2ide-vscode add postcss@8.5.16 postcss-scss@4.0.9
```

Expected: both packages appear under VS Code runtime dependencies and the
lockfile changes.

- [ ] **Step 2: Write failing CSS plugin tests**

Create tests that pass a real `SourceDocument` and fake `SourceWorkspace`:

```ts
it("returns every complete selected and parent CSS rule", async () => {
  const text = [
    ".layout { display: grid; }",
    ".card { color: red; }",
    "@media (min-width: 40rem) {",
    "  .card { color: blue; }",
    "}",
  ].join("\n");
  const result = await resolveCss(text, selection([
    cssTarget("selected", ".card", "/dist/app.css"),
    cssTarget("parent", ".layout", "/dist/app.css"),
  ]));

  expect(result.matches.map((match) => [match.targetRole, match.label])).toEqual([
    ["selected", ".card"],
    ["selected", ".card"],
    ["parent", ".layout"],
  ]);
  expect(snippets(text, result.matches)).toEqual([
    ".card { color: red; }",
    ".card { color: blue; }",
    ".layout { display: grid; }",
  ]);
});

it("uses exact confidence for a positioned fact and heuristic for selector fallback", async () => {
  const exact = await resolvePositionedFact();
  const fallback = await resolveSelectorOnlyFact();

  expect(exact.matches[0].confidence).toBe("exact");
  expect(fallback.matches[0].confidence).toBe("heuristic");
});

it("does not match an ambiguous or different active CSS source", async () => {
  const result = await resolveWithAmbiguousAppCss();
  expect(result.matches).toEqual([]);
  expect(result.diagnostics[0]?.code).toBe("css.sourceAmbiguous");
});
```

Also assert declaration facts from the same CSS rule coalesce and malformed CSS
returns `css.parseFailed` without a stale range.

- [ ] **Step 3: Run CSS tests and verify RED**

Run:

```powershell
corepack pnpm --filter browser2ide-vscode test -- cssSourcePlugin.test.ts
```

Expected: FAIL because the plugin and AST helpers do not exist.

- [ ] **Step 4: Implement target-aware CSS fact grouping**

Create `cssFacts.ts` with:

```ts
export interface TargetCssFact {
  readonly targetRole: "selected" | "parent";
  readonly fact: CssRuleFact;
  readonly sourceUrl: string;
}

export function targetCssFacts(selection: SelectionSnapshot): TargetCssFact[] {
  const unique = new Map<string, TargetCssFact>();
  for (const target of selection.targets) {
    for (const fact of target.facts) {
      if (fact.type !== "css-rule") continue;
      const sourceUrl = cssFactSourceUrl(fact);
      if (!sourceUrl) continue;
      const key = JSON.stringify([
        target.role,
        sourceUrl,
        fact.selector,
        fact.source?.line ?? null,
        fact.source?.column ?? null,
        fact.metadata.rulePath ?? null,
        fact.metadata.media ?? null,
      ]);
      if (!unique.has(key)) unique.set(key, { targetRole: target.role, fact, sourceUrl });
    }
  }
  return [...unique.values()];
}
```

`cssFactSourceUrl` checks `metadata.sourceUrl`, `metadata.stylesheet`, and then
`source.uri`, in that order.

- [ ] **Step 5: Implement cached PostCSS rule ranges**

Create `stylesheetAst.ts`. Parse CSS with `postcss.parse` and SCSS with
`postcss-scss.parse`, walk only `Rule` nodes, and convert inclusive PostCSS end
offsets to end-exclusive ranges:

```ts
export interface StylesheetRule {
  readonly selector: string;
  readonly range: SourceRange;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly media: readonly string[];
}

function ruleFromNode(node: Rule, document: SourceDocument): StylesheetRule | undefined {
  const start = node.source?.start?.offset;
  const inclusiveEnd = node.source?.end?.offset;
  if (start === undefined || inclusiveEnd === undefined) return undefined;
  const end = inclusiveEnd + 1;
  return {
    selector: node.selector,
    range: { start: document.positionAt(start), end: document.positionAt(end) },
    startOffset: start,
    endOffset: end,
    media: containingMedia(node),
  };
}
```

Cache active documents by `syntax + uri + version`; cache generated text by
`syntax + uri + sha256(text)`. Expose selector normalization, media filtering,
and smallest-containing-rule lookup for SCSS.

- [ ] **Step 6: Implement CssSourcePlugin**

Create `cssSourcePlugin.ts`:

```ts
export class CssSourcePlugin implements SourcePlugin {
  readonly id = "browser2ide.css";
  readonly displayName = "Browser2IDE CSS";
  readonly apiVersion = SOURCE_PLUGIN_API_VERSION;
  readonly documentSelectors = [{ languageId: "css", scheme: "file" }] as const;
  readonly supportedFactKinds = ["css-rule"] as const;

  constructor(private readonly ast = new StylesheetAstCache()) {}

  async resolve(context: SourcePluginContext): Promise<SourcePluginResult> {
    const parsed = this.ast.parseDocument(context.document, "css");
    const matches: SourceMatch[] = [];
    const diagnostics: PluginDiagnostic[] = [];
    for (const entry of targetCssFacts(context.selection)) {
      if (context.signal.aborted) break;
      const resolution = await context.workspace.resolveSourceUri(
        entry.sourceUrl,
        context.selection.context.url,
      );
      if (resolution.status === "ambiguous") {
        diagnostics.push(ambiguousSourceDiagnostic(entry.sourceUrl));
      }
      if (!resolution.uris.includes(context.document.uri)) continue;
      for (const rule of findMatchingCssRules(parsed.rules, entry.fact, context.document)) {
        matches.push({
          targetRole: entry.targetRole,
          range: rule.range,
          label: entry.fact.selector,
          kind: "style-rule",
          relation: "styles",
          confidence: entry.fact.source ? "exact" : "heuristic",
          metadata: { sourceUrl: entry.sourceUrl },
        });
      }
    }
    return { matches, diagnostics };
  }
}
```

Wrap parser errors as `css.parseFailed`; report ambiguous source resolution as
`css.sourceAmbiguous`. Do not return external/unmapped pseudo-matches because
the view is scoped to the active file.

- [ ] **Step 7: Verify CSS plugin behavior**

Run:

```powershell
corepack pnpm --filter browser2ide-vscode test -- cssSourcePlugin.test.ts
corepack pnpm --filter browser2ide-vscode typecheck
```

Expected: all CSS tests and typecheck pass.

- [ ] **Step 8: Commit CSS support**

```powershell
git add extensions/vscode/src/sourcePlugins extensions/vscode/test/cssSourcePlugin.test.ts extensions/vscode/package.json pnpm-lock.yaml
git commit -m "feat(vscode): add CSS source plugin"
```

### Task 6: Implement ScssSourcePlugin And Source-Map Loading

**Files:**
- Create: `extensions/vscode/src/sourcePlugins/sourceMapLoader.ts`
- Create: `extensions/vscode/src/sourcePlugins/scssSourcePlugin.ts`
- Create: `extensions/vscode/test/sourceMapLoader.test.ts`
- Create: `extensions/vscode/test/scssSourcePlugin.test.ts`

- [ ] **Step 1: Write failing source-map loader tests**

Cover external and inline maps with concrete data:

```ts
it("loads an external source map relative to generated CSS", async () => {
  const workspace = memoryWorkspace({
    "file:///workspace/dist/app.css.map": JSON.stringify(rawMap),
  });
  const loaded = await loadSourceMap({
    generatedUri: "file:///workspace/dist/app.css",
    generatedText: "a{}\n/*# sourceMappingURL=app.css.map */",
    workspace,
  });

  expect(loaded.mapUri).toBe("file:///workspace/dist/app.css.map");
  expect(loaded.rawMap.sources).toEqual(["../src/app.scss"]);
});

it("loads a base64 inline source map", async () => {
  const encoded = Buffer.from(JSON.stringify(rawMap)).toString("base64");
  const loaded = await loadSourceMap({
    generatedUri: "file:///workspace/dist/app.css",
    generatedText: `a{}\n/*# sourceMappingURL=data:application/json;base64,${encoded} */`,
    workspace: memoryWorkspace({}),
  });

  expect(loaded.mapUri).toContain("#inline-source-map");
  expect(loaded.rawMap.file).toBe("app.css");
});
```

Also assert missing directives produce `scss.sourceMapMissing` and invalid JSON
produces `scss.sourceMapInvalid`.

- [ ] **Step 2: Write failing SCSS plugin tests**

Reuse committed `examples/basic-css/dist/app.css.map` through a fake
`SourceWorkspace`, and add generated maps for edge cases:

```ts
it("maps selected and parent rules to complete blocks in layout.scss", async () => {
  const result = await resolveFixtureScss(
    "examples/basic-css/src/layout.scss",
    selection([
      cssTarget("selected", ".layout > .card", "/dist/app.css"),
      cssTarget("parent", ".layout", "/dist/app.css"),
    ]),
  );

  expect(result.matches.map((match) => match.targetRole)).toEqual([
    "parent",
    "selected",
  ]);
  expect(await fixtureSnippets(result.matches)).toEqual([
    ".layout {\n  display: grid;\n  gap: 1.5rem;\n}",
    ".layout > .card {\n  max-width: 32rem;\n}",
  ]);
  expect(result.matches.every((match) => match.confidence === "sourcemap")).toBe(true);
});

it("uses mapped position for repeated and nested SCSS rules", async () => {
  const result = await resolveGeneratedRepeatedFixture();
  expect(snippet(result.matches[0])).toContain("&.featured");
});

it.each([
  ["missing", "scss.sourceMapMissing"],
  ["invalid", "scss.sourceMapInvalid"],
  ["unmapped", "scss.mappingMissing"],
])("returns diagnostics and no heuristic for a %s map", async (kind, code) => {
  const result = await resolveBrokenMap(kind);
  expect(result.matches).toEqual([]);
  expect(result.diagnostics.map((entry) => entry.code)).toContain(code);
});
```

- [ ] **Step 3: Run source-map and SCSS tests and verify RED**

Run:

```powershell
corepack pnpm --filter browser2ide-vscode test -- sourceMapLoader.test.ts scssSourcePlugin.test.ts
```

Expected: FAIL because the loader and SCSS plugin do not exist.

- [ ] **Step 4: Implement source-map loading and content-hash cache**

Create `sourceMapLoader.ts` with a loader that extracts the last
`sourceMappingURL`, supports percent-encoded and base64 data URLs, resolves
external map URIs through `SourceWorkspace`, and parses JSON. Return a typed
diagnostic instead of throwing for expected map failures.

The directive extraction must use this behavior:

```ts
const directives = [
  ...generatedText.matchAll(
    /(?:\/\*[#@]\s*|\/\/[#@]\s*)sourceMappingURL=([^\s*]+)[^\n]*?/g,
  ),
];
const reference = directives.at(-1)?.[1];
```

Cache successful parsed maps by `mapUri + sha256(rawJson)`. Inline maps use
`${generatedUri}#inline-source-map` as their stable URI.

- [ ] **Step 5: Implement ScssSourcePlugin**

Create `scssSourcePlugin.ts`:

```ts
export class ScssSourcePlugin implements SourcePlugin {
  readonly id = "browser2ide.scss";
  readonly displayName = "Browser2IDE SCSS";
  readonly apiVersion = SOURCE_PLUGIN_API_VERSION;
  readonly documentSelectors = [{ languageId: "scss", scheme: "file" }] as const;
  readonly supportedFactKinds = ["css-rule"] as const;

  constructor(
    private readonly ast = new StylesheetAstCache(),
    private readonly maps = new SourceMapLoader(),
  ) {}

  async resolve(context: SourcePluginContext): Promise<SourcePluginResult> {
    const original = this.ast.parseDocument(context.document, "scss");
    const matches: SourceMatch[] = [];
    const diagnostics: PluginDiagnostic[] = [];
    for (const entry of targetCssFacts(context.selection)) {
      if (context.signal.aborted) break;
      const generatedResolution = await context.workspace.resolveSourceUri(
        entry.sourceUrl,
        context.selection.context.url,
      );
      for (const generatedUri of generatedResolution.uris) {
        const generatedText = await context.workspace.readText(generatedUri);
        const generated = this.ast.parseText(generatedUri, "css", generatedText);
        const mapResult = await this.maps.load(generatedUri, generatedText, context.workspace);
        if (!mapResult.map) {
          diagnostics.push(...mapResult.diagnostics);
          continue;
        }
        for (const generatedRule of findMatchingCssRules(generated.rules, entry.fact)) {
          const mapped = await mapGeneratedStart(mapResult.map, generatedRule);
          if (!mapped) {
            diagnostics.push(mappingMissingDiagnostic(entry.fact.selector));
            continue;
          }
          const sourceResolution = await context.workspace.resolveSourceUri(
            mapped.source,
            mapResult.mapUri,
          );
          if (!sourceResolution.uris.includes(context.document.uri)) continue;
          const rule = smallestContainingRule(original.rules, context.document.offsetAt({
            line: mapped.line - 1,
            character: mapped.column,
          }));
          if (rule) matches.push(sourceMappedMatch(entry, rule, generatedUri, mapResult.mapUri));
        }
      }
    }
    return { matches, diagnostics };
  }
}
```

Use `SourceMapConsumer.with` so consumers are destroyed after each mapping
batch. Do not add selector fallback against SCSS.

- [ ] **Step 6: Verify SCSS and all source plugin tests**

Run:

```powershell
corepack pnpm --filter browser2ide-vscode test -- cssSourcePlugin.test.ts sourceMapLoader.test.ts scssSourcePlugin.test.ts
corepack pnpm --filter browser2ide-vscode typecheck
```

Expected: CSS and SCSS suites pass with no warnings.

- [ ] **Step 7: Commit SCSS support**

```powershell
git add extensions/vscode/src/sourcePlugins extensions/vscode/test/sourceMapLoader.test.ts extensions/vscode/test/scssSourcePlugin.test.ts
git commit -m "feat(vscode): add SCSS source plugin"
```

### Task 7: Collect The Selected Element And Immediate Parent In Firefox

**Files:**
- Create: `extensions/firefox/src/inspectPayload.ts`
- Create: `extensions/firefox/test/inspectPayload.test.ts`
- Modify: `extensions/firefox/src/contentScript.ts`
- Modify: `extensions/firefox/src/inspectMode.ts`
- Modify: `extensions/firefox/src/panel.ts`
- Modify: `extensions/firefox/src/panelDiagnostics.ts`
- Modify: `extensions/firefox/test/panelDiagnostics.test.ts`
- Modify: `extensions/firefox/test/inspectMode.test.ts`

- [ ] **Step 1: Write failing inspect payload tests**

Create `inspectPayload.test.ts`:

```ts
it("collects selected and immediate-parent targets independently", () => {
  const parent = element("main", "", ["layout"], null);
  const selected = element("article", "", ["card", "featured"], parent);
  const payload = createInspectPayload(selected, fakeDocument([
    rule(".layout", parent, "display", "grid"),
    rule(".card", selected, "display", "block"),
  ]), locationSource());

  expect(payload.targets.map((target) => [target.role, target.depth])).toEqual([
    ["selected", 0],
    ["parent", 1],
  ]);
  expect(payload.targets[0].facts.map((fact) => fact.type)).toContain("css-rule");
  expect(payload.targets[1].subject.selector).toBe("main.layout");
});

it("omits parent for a root element", () => {
  const payload = createInspectPayload(
    element("html", "", [], null),
    fakeDocument([]),
    locationSource(),
  );

  expect(payload.targets).toHaveLength(1);
  expect(payload.targets[0].role).toBe("selected");
});
```

Add a case proving a rule matching both elements appears in both targets and
inaccessible stylesheet errors are deduplicated by source URL plus reason.

- [ ] **Step 2: Run Firefox payload tests and verify RED**

Run:

```powershell
corepack pnpm --filter browser2ide-firefox test -- inspectPayload.test.ts
```

Expected: FAIL because `createInspectPayload` does not exist.

- [ ] **Step 3: Extend the inspectable element contract**

In `inspectMode.ts`, add the immediate parent to `InspectableElement`:

```ts
export type InspectableElement = ElementSnapshotSource & MatchableElement & {
  readonly parentElement: InspectableElement | null;
};
```

Update `isInspectableElement` to accept `parentElement === null` or an object;
do not recursively validate the complete ancestor chain.

- [ ] **Step 4: Implement pure payload construction**

Create `inspectPayload.ts`:

```ts
export function createInspectPayload(
  element: InspectableElement,
  document: CssDocumentSource,
  location: LocationSource,
): InspectPayload & { readonly inaccessibleStylesheets: readonly InaccessibleStylesheet[] } {
  const selected = collectTarget("selected", 0, element, document, location.href);
  const parent = element.parentElement
    ? collectTarget("parent", 1, element.parentElement, document, location.href)
    : undefined;
  const targets = parent ? [selected, parent] : [selected];
  const inaccessibleStylesheets = deduplicateInaccessible(
    targets.flatMap((target) => target.inaccessibleStylesheets),
  );
  return {
    targets: targets.map(({ inaccessibleStylesheets: _ignored, ...target }) => target),
    context: {
      url: location.href,
      route: `${location.pathname}${location.search}${location.hash}`,
      metadata: {
        inaccessibleStylesheetCount: inaccessibleStylesheets.length,
        browserErrors: inaccessibleStylesheets,
      },
    },
    metadata: {},
    inaccessibleStylesheets,
  };
}
```

`collectTarget` calls `createElementSnapshot` and `collectCssFacts` once for
that target.

- [ ] **Step 5: Wire content script and panel diagnostics**

Replace inline payload construction in `contentScript.ts` with
`createInspectPayload`. In `panel.ts`, use `payload.targets` directly and show
the selected selector plus total fact count. Change `PanelDiagnostics` to
record total facts across both targets.

- [ ] **Step 6: Verify Firefox**

Run:

```powershell
corepack pnpm --filter browser2ide-firefox test
corepack pnpm --filter browser2ide-firefox build
corepack pnpm dlx web-ext@10.4.0 lint --source-dir extensions/firefox --ignore-files package.json pnpm-lock.yaml tsconfig.json esbuild.mjs "src/**" "test/**"
```

Expected: Firefox tests/build pass and web-ext reports 0 errors, warnings, and
notices.

- [ ] **Step 7: Commit parent target collection**

```powershell
git add extensions/firefox
git commit -m "feat(firefox): collect parent target facts"
```

### Task 8: Add SelectionStore And ActiveEditorCoordinator

**Files:**
- Create: `extensions/vscode/src/presenter/selectionStore.ts`
- Create: `extensions/vscode/src/presenter/activeEditorCoordinator.ts`
- Create: `extensions/vscode/test/selectionStore.test.ts`
- Create: `extensions/vscode/test/activeEditorCoordinator.test.ts`

- [ ] **Step 1: Write failing selection and coordinator tests**

Use Vitest fake timers and a registry fake that resolves real
`SourceResolution` values:

```ts
it("retains selection and resolves it against each active editor", async () => {
  const harness = coordinatorHarness();
  harness.coordinator.select(inspectMessage("inspect-1"));
  await harness.flush();
  harness.changeActiveEditor(editor("file:///src/card.scss", "scss", 1));
  await harness.flush();

  expect(harness.resolveCalls.map((call) => call.document.languageId)).toEqual([
    "css",
    "scss",
  ]);
  expect(harness.openDocumentCalls).toBe(0);
});

it("debounces active document changes by 150ms", async () => {
  vi.useFakeTimers();
  const harness = coordinatorHarness();
  harness.coordinator.select(inspectMessage("inspect-1"));
  harness.changeDocumentVersion(2);
  harness.changeDocumentVersion(3);
  await vi.advanceTimersByTimeAsync(149);
  expect(harness.resolveCalls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(harness.resolveCalls).toHaveLength(2);
});

it("aborts and ignores a stale resolution", async () => {
  const harness = deferredCoordinatorHarness();
  harness.coordinator.select(inspectMessage("old"));
  harness.coordinator.select(inspectMessage("new"));
  harness.resolve("old", resolution("old"));
  harness.resolve("new", resolution("new"));
  await harness.flush();

  expect(harness.published.map((entry) => entry.selectionMessageId)).toEqual(["new"]);
});
```

Also test clearing presentation when no active editor exists and re-resolving
when the registry emits a plugin lifecycle change.

- [ ] **Step 2: Run coordinator tests and verify RED**

Run:

```powershell
corepack pnpm --filter browser2ide-vscode test -- selectionStore.test.ts activeEditorCoordinator.test.ts
```

Expected: FAIL because both classes are missing.

- [ ] **Step 3: Implement SelectionStore**

Create `selectionStore.ts`:

```ts
export class SelectionStore {
  private value: SelectionSnapshot | undefined;

  replace(message: InspectMessage): SelectionSnapshot {
    this.value = {
      sessionId: message.sessionId,
      messageId: message.messageId,
      targets: message.targets,
      context: message.context,
      metadata: message.metadata,
    };
    return this.value;
  }

  current(): SelectionSnapshot | undefined {
    return this.value;
  }

  clear(): void {
    this.value = undefined;
  }
}
```

- [ ] **Step 4: Implement ActiveEditorCoordinator**

Create the coordinator with injected host events, registry, workspace,
`SelectionStore`, and callbacks `publish(editor, resolution)` and `clear()`.
Use an incrementing generation and `AbortController`:

```ts
private async resolveCurrent(): Promise<void> {
  const selection = this.store.current();
  const editor = this.host.getActiveEditor();
  this.abort?.abort();
  const abort = new AbortController();
  this.abort = abort;
  const generation = ++this.generation;
  if (!selection || !editor) {
    this.options.clear();
    return;
  }
  const document = adaptSourceDocument(editor.document);
  const result = await this.options.registry.resolve(
    selection,
    document,
    this.options.workspace,
    abort.signal,
  );
  if (abort.signal.aborted || generation !== this.generation) return;
  this.options.publish(editor, result);
}
```

Resolve immediately for inspect/editor/plugin events. Debounce only active
document edits for 150 milliseconds. Dispose every event subscription and
abort pending work.

- [ ] **Step 5: Verify coordinator behavior**

Run:

```powershell
corepack pnpm --filter browser2ide-vscode test -- selectionStore.test.ts activeEditorCoordinator.test.ts
corepack pnpm --filter browser2ide-vscode typecheck
```

Expected: all coordinator tests pass.

- [ ] **Step 6: Commit active-editor coordination**

```powershell
git add extensions/vscode/src/presenter/selectionStore.ts extensions/vscode/src/presenter/activeEditorCoordinator.ts extensions/vscode/test/selectionStore.test.ts extensions/vscode/test/activeEditorCoordinator.test.ts
git commit -m "feat(vscode): resolve active source document"
```

### Task 9: Replace The Presenter With Applicable Sources

**Files:**
- Create: `extensions/vscode/src/presenter/applicableSourcesTree.ts`
- Rewrite: `extensions/vscode/src/presenter/decorations.ts`
- Rewrite: `extensions/vscode/src/presenter/commands.ts`
- Create: `extensions/vscode/test/applicableSourcesTree.test.ts`
- Rewrite: `extensions/vscode/test/decorations.test.ts`
- Rewrite: `extensions/vscode/test/commands.test.ts`
- Modify: `extensions/vscode/package.json`
- Delete: `extensions/vscode/src/presenter/applicableRulesTree.ts`
- Delete: `extensions/vscode/test/applicableRulesTree.test.ts`

- [ ] **Step 1: Write failing semantic decoration tests**

Replace old decoration assertions with:

```ts
it("decorates every selected range and distinct non-overlapping parent ranges", () => {
  const harness = decorationHarness();
  const shared = range(0, 0, 2, 1);
  harness.manager.update(harness.editor, snapshot([
    resolvedMatch("selected", shared, "browser2ide.scss"),
    resolvedMatch("parent", shared, "browser2ide.scss"),
    resolvedMatch("parent", range(4, 0, 6, 1), "browser2ide.scss"),
  ]));

  expect(harness.rangesFor("primary")).toEqual([shared]);
  expect(harness.rangesFor("context")).toEqual([range(4, 0, 6, 1)]);
});

it("clears decorations from the previous active editor", () => {
  const harness = decorationHarness();
  harness.manager.update(harness.firstEditor, snapshot([selectedMatch()]));
  harness.manager.update(harness.secondEditor, snapshot([parentMatch()]));

  expect(harness.lastRanges(harness.firstEditor)).toEqual([]);
  expect(harness.lastRanges(harness.secondEditor)).not.toEqual([]);
});
```

- [ ] **Step 2: Write failing Applicable Sources tree and reveal tests**

Create tree tests that assert labels and current-file behavior:

```ts
it("shows target role, label, confidence, plugin diagnostics", () => {
  const tree = new ApplicableSourcesTreeDataProvider();
  tree.update(snapshot([
    resolvedMatch("selected", range(0, 0, 2, 1), "browser2ide.scss", ".card", "sourcemap"),
    resolvedMatch("parent", range(4, 0, 6, 1), "browser2ide.scss", ".layout", "sourcemap"),
  ], [diagnostic("scss.sourceMapMissing")]));

  expect(tree.getChildren().map((item) => item.label)).toEqual([
    "Selected  .card",
    "Parent  .layout",
    "SCSS source map was not found",
  ]);
});
```

Rewrite command tests so `browser2ide.revealSourceMatch` only calls
`revealRange` on the active editor and never calls `openTextDocument` or
`showTextDocument`.

- [ ] **Step 3: Run presenter tests and verify RED**

Run:

```powershell
corepack pnpm --filter browser2ide-vscode test -- decorations.test.ts applicableSourcesTree.test.ts commands.test.ts
```

Expected: FAIL because semantic presenter types do not exist.

- [ ] **Step 4: Implement semantic decorations**

Create exactly two decoration types:

```ts
export type DecorationRole = "primary" | "context";

const STYLES: Record<DecorationRole, vscode.DecorationRenderOptions> = {
  primary: {
    backgroundColor: new vscode.ThemeColor("browser2ide.selectedRuleBackground"),
    borderColor: new vscode.ThemeColor("browser2ide.selectedRuleBorder"),
    borderStyle: "solid",
    borderWidth: "0 0 0 2px",
    overviewRulerColor: new vscode.ThemeColor("browser2ide.selectedRuleBorder"),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  },
  context: {
    backgroundColor: new vscode.ThemeColor("browser2ide.parentRuleBackground"),
    borderColor: new vscode.ThemeColor("browser2ide.parentRuleBorder"),
    borderStyle: "solid",
    borderWidth: "0 0 0 2px",
    overviewRulerColor: new vscode.ThemeColor("browser2ide.parentRuleBorder"),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  },
};
```

Keep VS Code objects behind the existing host interface so unit tests remain
pure. Exclude parent ranges whose serialized start/end equals a selected range.

- [ ] **Step 5: Implement ApplicableSourcesTree and active-file reveal**

Store `ResolvedSourceMatch` by stable ID. Match items use command
`browser2ide.revealSourceMatch`; diagnostic items have no command. Format match
labels as `Selected  ${label}` or `Parent  ${label}` and descriptions as
`${confidence} - ${pluginId}`.

The command implementation must verify the match belongs to the current
snapshot, create a VS Code range, call `editor.revealRange`, and set the editor
selection to the range start. It must report an error if no matching active
editor exists, without opening a document.

- [ ] **Step 6: Update VS Code contributions**

In `extensions/vscode/package.json`:

- rename the view display name to `Applicable Sources` while retaining view ID
  `browser2ide.applicableRules`;
- replace command `browser2ide.openReference` with
  `browser2ide.revealSourceMatch`;
- add four contributed colors:

```json
"colors": [
  {
    "id": "browser2ide.selectedRuleBackground",
    "description": "Background for rules matching the selected DOM element.",
    "defaults": { "dark": "#2EA04322", "light": "#1A7F3720", "highContrast": "#00000000" }
  },
  {
    "id": "browser2ide.selectedRuleBorder",
    "description": "Border for rules matching the selected DOM element.",
    "defaults": { "dark": "#3FB950", "light": "#1A7F37", "highContrast": "#FFFFFF" }
  },
  {
    "id": "browser2ide.parentRuleBackground",
    "description": "Background for rules matching the immediate DOM parent.",
    "defaults": { "dark": "#2F81F722", "light": "#0969DA1F", "highContrast": "#00000000" }
  },
  {
    "id": "browser2ide.parentRuleBorder",
    "description": "Border for rules matching the immediate DOM parent.",
    "defaults": { "dark": "#58A6FF", "light": "#0969DA", "highContrast": "#FFFFFF" }
  }
]
```

- [ ] **Step 7: Verify presenter tests and manifest**

Run:

```powershell
corepack pnpm --filter browser2ide-vscode test -- decorations.test.ts applicableSourcesTree.test.ts commands.test.ts manifest.test.ts
corepack pnpm --filter browser2ide-vscode typecheck
```

Expected: presenter and manifest tests pass.

- [ ] **Step 8: Commit the new presenter surface**

```powershell
git add extensions/vscode/src/presenter extensions/vscode/test extensions/vscode/package.json
git commit -m "feat(vscode): show active source matches"
```

### Task 10: Wire Built-In Plugins And Remove The Legacy Resolver

**Files:**
- Create: `extensions/vscode/src/sourcePlugins/api.ts`
- Rewrite: `extensions/vscode/src/presenter/runtime.ts`
- Modify: `extensions/vscode/src/extension.ts`
- Modify: `extensions/vscode/src/config.ts`
- Modify: `extensions/vscode/src/diagnostics.ts`
- Modify: `extensions/vscode/package.json`
- Rewrite: `extensions/vscode/test/presenterRuntime.test.ts`
- Rewrite: `extensions/vscode/test/diagnostics.test.ts`
- Modify: `extensions/vscode/test/manifest.test.ts`
- Delete: `extensions/vscode/src/references/cssRuleResolver.ts`
- Delete: `extensions/vscode/src/references/referenceStore.ts`
- Delete: `extensions/vscode/src/references/sourceResolverRegistry.ts`
- Delete: `extensions/vscode/src/references/sourceTypes.ts`
- Delete: `extensions/vscode/src/references/sourcemapResolver.ts`
- Delete: `extensions/vscode/src/references/workspaceFiles.ts`
- Delete: `extensions/vscode/src/presenter/openReferences.ts`
- Delete: `extensions/vscode/test/cssRuleResolver.test.ts`
- Delete: `extensions/vscode/test/openReferences.test.ts`
- Delete: `extensions/vscode/test/referenceStore.test.ts`

- [ ] **Step 1: Write failing runtime composition tests**

Rewrite `presenterRuntime.test.ts` to prove runtime semantics:

```ts
it("registers built-ins, retains selection, and publishes active-document matches", async () => {
  const harness = runtimeHarness({ activeLanguageId: "scss" });
  harness.runtime.select(inspectMessageWithSelectedAndParent());
  await harness.flush();

  expect(harness.registeredPluginIds).toEqual([
    "browser2ide.css",
    "browser2ide.scss",
  ]);
  expect(harness.openDocumentCalls).toBe(0);
  expect(harness.treeSnapshot.documentUri).toBe("file:///workspace/src/layout.scss");
});

it("re-resolves after an external plugin is registered and disposed", async () => {
  const harness = runtimeHarness({ activeLanguageId: "fixture" });
  harness.runtime.select(inspectMessageWithCustomFact());
  const registration = harness.runtime.api.registerSourcePlugin(fixturePlugin());
  await harness.flush();
  expect(harness.latestMatches).toHaveLength(1);
  registration.dispose();
  await harness.flush();
  expect(harness.latestMatches).toEqual([]);
});
```

Update diagnostics tests to expect total target facts, active matches, plugin
diagnostic count, and no unmapped/external reference counters.

- [ ] **Step 2: Run runtime tests and verify RED**

Run:

```powershell
corepack pnpm --filter browser2ide-vscode test -- presenterRuntime.test.ts diagnostics.test.ts manifest.test.ts
```

Expected: FAIL because runtime still composes the legacy resolver/presenter.

- [ ] **Step 3: Implement the exported API wrapper**

Create `sourcePlugins/api.ts`:

```ts
export function createBrowser2IDEApi(
  registry: SourcePluginRegistry,
): Browser2IDEApi {
  return Object.freeze({
    apiVersion: SOURCE_PLUGIN_API_VERSION,
    registerSourcePlugin: (plugin: SourcePlugin) => registry.register(plugin),
  });
}
```

- [ ] **Step 4: Rewrite presenter runtime composition**

`createPresenterRuntime` must create one registry, register `CssSourcePlugin`
and `ScssSourcePlugin`, construct `VsCodeSourceWorkspace`, tree, semantic
decorations, and coordinator, then return:

```ts
export interface PresenterRuntime extends DisposableLike {
  readonly api: Browser2IDEApi;
  readonly tree: ApplicableSourcesTreeDataProvider;
  select(message: InspectMessage): void;
}
```

The coordinator publish callback updates tree, decorations, and diagnostics.
The clear callback empties both presentation surfaces. Dispose in reverse
construction order.

- [ ] **Step 5: Wire extension activation and preserve pairing behavior**

Change activation to return the public API:

```ts
export async function activate(
  context: vscode.ExtensionContext,
): Promise<Browser2IDEApi> {
  // Existing bridge and pairing initialization remains.
  // Presenter runtime is created before command registration.
  try {
    await start();
  } catch (error) {
    reportError(error);
  }
  return presenterRuntime.api;
}
```

In the inspect callback, replace resolver/open logic with:

```ts
diagnostics?.recordInspect(message);
output?.appendLine(`inspect ${message.messageId}`);
presenterRuntime?.select(message);
```

Do not modify the already checkpointed `showPairingCode` command behavior.

- [ ] **Step 6: Remove legacy configuration, resolver, and tests**

Remove `openAllReferences` from `BridgeConfiguration`, package configuration,
and all runtime reads. Delete every legacy file listed in this task after all
imports are gone.

Update diagnostics to expose:

```ts
readonly targetsReceived: number;
readonly factsReceived: number;
readonly matchesResolved: number;
readonly pluginDiagnostics: number;
```

`recordInspect` counts targets and all target facts. `recordResolution` records
matches and diagnostics from `SourceResolution`.

- [ ] **Step 7: Set the canonical extension ID**

Add to `extensions/vscode/package.json`:

```json
"publisher": "browser2ide"
```

Keep package name `browser2ide-vscode`, producing extension ID
`browser2ide.browser2ide-vscode`.

- [ ] **Step 8: Verify no legacy surface remains**

Run:

```powershell
rg -n "CssRuleResolver|SourceResolverRegistry|openAllReferences|openReferences\(|ApplicableRulesTree" extensions/vscode
corepack pnpm --filter browser2ide-vscode test
corepack pnpm --filter browser2ide-vscode build
```

Expected: `rg` returns no matches; VS Code tests and build pass.

- [ ] **Step 9: Commit the core migration**

```powershell
git add extensions/vscode
git commit -m "refactor(vscode)!: use source plugins"
```

Include this commit body:

```text
BREAKING CHANGE: inspect events no longer open source files or use the
openAllReferences setting. Only the active document is resolved.
```

### Task 11: Prove Cross-Extension Registration In Extension Host

**Files:**
- Create: `extensions/source-plugin-fixture/package.json`
- Create: `extensions/source-plugin-fixture/tsconfig.json`
- Create: `extensions/source-plugin-fixture/esbuild.mjs`
- Create: `extensions/source-plugin-fixture/src/extension.ts`
- Create: `extensions/vscode/.vscode-test.mjs`
- Create: `extensions/vscode/test/integration/sourcePluginApi.test.ts`
- Modify: `extensions/vscode/esbuild.mjs`
- Modify: `extensions/vscode/package.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add Extension Host test dependencies**

Run:

```powershell
corepack pnpm --filter browser2ide-vscode add -D @vscode/test-cli@0.0.15 @vscode/test-electron@3.0.0 @types/mocha mocha
```

Add root script:

```json
"test:integration": "pnpm --filter browser2ide-vscode test:integration"
```

- [ ] **Step 2: Write the failing Extension Host test**

Create `extensions/vscode/test/integration/sourcePluginApi.test.ts`:

```ts
import * as assert from "node:assert/strict";
import * as vscode from "vscode";

suite("Browser2IDE external source plugin API", () => {
  test("activates the fixture through the public core API", async () => {
    const fixture = vscode.extensions.getExtension<{
      readonly registered: boolean;
      readonly coreApiVersion: number;
    }>("browser2ide.source-plugin-fixture");

    assert.ok(fixture, "fixture extension must be loaded as a development extension");
    const exported = await fixture.activate();
    assert.equal(exported.registered, true);
    assert.equal(exported.coreApiVersion, 1);
  });
});
```

- [ ] **Step 3: Configure VS Code test CLI and verify RED**

Create `.vscode-test.mjs`:

```js
import { resolve } from "node:path";
import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  label: "sourcePluginApi",
  files: "dist/test/integration/**/*.test.cjs",
  version: "1.124.2",
  workspaceFolder: resolve("../../examples/basic-css"),
  extensionDevelopmentPath: [
    resolve("."),
    resolve("../source-plugin-fixture"),
  ],
  mocha: { ui: "tdd", timeout: 20_000 },
  launchArgs: ["--disable-telemetry", "--disable-extension-update-checks"],
});
```

Extend `esbuild.mjs` with a second build entry for the test file, externalizing
`vscode` and writing `dist/test/integration/sourcePluginApi.test.cjs`.

Run:

```powershell
corepack pnpm --filter browser2ide-vscode build
corepack pnpm --filter browser2ide-vscode exec vscode-test --label sourcePluginApi
```

Expected: FAIL because the fixture extension is not present.

- [ ] **Step 4: Create the external fixture extension**

Create its manifest with publisher `browser2ide`, name
`source-plugin-fixture`, main `dist/extension.cjs`, and:

```json
"extensionDependencies": ["browser2ide.browser2ide-vscode"]
```

The package depends on `@browser2ide/plugin-api` and contributes language ID
`browser2ide-fixture` for `.b2i` files. Build with esbuild while externalizing
`vscode`.

Implement `src/extension.ts`:

```ts
import * as vscode from "vscode";
import {
  SOURCE_PLUGIN_API_VERSION,
  type Browser2IDEApi,
  type SourcePlugin,
} from "@browser2ide/plugin-api";

const plugin: SourcePlugin = {
  id: "browser2ide.fixture",
  displayName: "Browser2IDE Fixture",
  apiVersion: SOURCE_PLUGIN_API_VERSION,
  documentSelectors: [{ languageId: "browser2ide-fixture", scheme: "file" }],
  supportedFactKinds: ["fixture.source"],
  async resolve(context) {
    const end = context.document.positionAt(context.document.getText().length);
    return {
      matches: [{
        targetRole: "selected",
        range: { start: { line: 0, character: 0 }, end },
        label: "Fixture source",
        kind: "fixture",
        relation: "defines",
        confidence: "instrumented",
      }],
    };
  },
};

export async function activate(context: vscode.ExtensionContext) {
  const core = vscode.extensions.getExtension<Browser2IDEApi>(
    "browser2ide.browser2ide-vscode",
  );
  if (!core) throw new Error("Browser2IDE core extension is unavailable");
  const api = await core.activate();
  if (api.apiVersion !== SOURCE_PLUGIN_API_VERSION) {
    throw new Error(`Unsupported Browser2IDE API version: ${api.apiVersion}`);
  }
  context.subscriptions.push(api.registerSourcePlugin(plugin));
  return { registered: true, coreApiVersion: api.apiVersion };
}
```

- [ ] **Step 5: Add package scripts and run integration GREEN**

Core VS Code package scripts:

```json
"test:integration": "pnpm run build && pnpm --filter browser2ide-source-plugin-fixture build && vscode-test --label sourcePluginApi"
```

Run:

```powershell
corepack pnpm install
corepack pnpm test:integration
```

Expected: VS Code 1.124.2 launches, the one Mocha integration test passes, and
the Extension Host exits 0.

- [ ] **Step 6: Commit the fixture and integration gate**

```powershell
git add package.json pnpm-lock.yaml extensions/vscode extensions/source-plugin-fixture
git commit -m "test(vscode): verify external source plugin"
```

### Task 12: Write The Plugin Authoring Guide And Ecosystem Recipes

**Files:**
- Create: `docs/source-plugin-authoring.md`
- Create: `extensions/source-plugin-fixture/README.md`
- Modify: `docs/protocol.md`
- Modify: `docs/security.md`

- [ ] **Step 1: Write the public setup and registration example**

In `docs/source-plugin-authoring.md`, include a complete manifest fragment:

```json
{
  "publisher": "example",
  "name": "browser2ide-twig",
  "engines": { "vscode": "^1.85.0" },
  "extensionDependencies": ["browser2ide.browser2ide-vscode"],
  "activationEvents": ["onLanguage:twig"]
}
```

Include the same safe activation/version-check pattern used by the fixture and
a complete `SourcePlugin` example returning a zero-based, end-exclusive range.

- [ ] **Step 2: Document resolver behavior and contract testing**

Document these exact rules:

- dispatch is based on active `languageId`, scheme, and fact kinds;
- `resolve` must check `AbortSignal` around expensive work;
- plugins return all matches in the active document only;
- plugins never open documents or choose colors;
- invalid ranges and stale results are discarded by core;
- exact, sourcemap, instrumented, heuristic, and unknown confidence meanings;
- fixture-style tests use fake `SourceDocument` and `SourceWorkspace` objects;
- the real boundary is tested with `corepack pnpm test:integration`.

- [ ] **Step 3: Add realistic ecosystem recipes**

Add separate headed sections with these required inputs and confidence:

```text
HTML                 selector + stable attributes          heuristic
JavaScript/TypeScript script/event source map              sourcemap
React                component + owner chain + source      instrumented
Vue                  component file hint + source map      instrumented/sourcemap
Twig/Blade/PHP       development server source hint        instrumented
WordPress/ACF        block name + PHP template + field ID  instrumented
```

State explicitly that React/Vue/template exactness cannot be reconstructed
reliably from final DOM alone. Show one valid `react.component` namespaced fact
and one valid `wordpress.acf-block` fact.

- [ ] **Step 4: Update protocol and security docs**

`docs/protocol.md` must describe protocol version 2, required targets, target
depth rules, namespaced facts, and document-first source resolution.

`docs/security.md` must state:

- Browser2IDE never loads plugin code from a workspace;
- external source plugins are separately installed VS Code extensions;
- host workspace services do not fetch network URLs;
- instrumentation must be development-only and must not expose secrets;
- pairing tokens must never appear in plugin diagnostics.

- [ ] **Step 5: Validate every documented command and identifier**

Run:

```powershell
rg -n "browser2ide\.browser2ide-vscode|SOURCE_PLUGIN_API_VERSION|registerSourcePlugin|react\.component|wordpress\.acf-block" docs/source-plugin-authoring.md docs/protocol.md docs/security.md extensions/source-plugin-fixture/README.md
corepack pnpm --filter browser2ide-source-plugin-fixture build
```

Expected: each public identifier appears in its intended documentation and the
fixture still builds.

- [ ] **Step 6: Commit authoring documentation**

```powershell
git add docs/source-plugin-authoring.md docs/protocol.md docs/security.md extensions/source-plugin-fixture/README.md
git commit -m "docs: add source plugin authoring guide"
```

### Task 13: Rewrite MVP Verification And Run The Final Gate

**Files:**
- Modify: `docs/mvp-usage.md`
- Modify: `docs/mvp-verification.md`
- Modify: `examples/basic-css/src/layout.scss` only if the committed fixture no longer contains both `.layout` and `.layout > .card`
- Modify: `examples/basic-css/dist/app.css` only when SCSS regeneration is required
- Modify: `examples/basic-css/dist/app.css.map` only when SCSS regeneration is required

- [ ] **Step 1: Rewrite the runbook for active-document behavior**

The VS Code section must instruct the tester to open
`examples/basic-css/src/layout.scss` before selecting `.card.featured`.
Replace every automatic-open expectation with:

```text
- no additional file opens after selection;
- `.layout > .card` is highlighted as Selected;
- `.layout` is highlighted with the distinct Parent decoration;
- both complete blocks appear in Applicable Sources;
- switching to `src/card.scss` highlights `.card` and `.featured` without a new browser click;
- switching to `dist/app.css` replaces SCSS highlights with CSS highlights;
- switching to an unsupported file clears all Browser2IDE decorations.
```

Keep the already-correct persistent pairing-code instructions because the new
approval pairing flow is outside this phase.

- [ ] **Step 2: Update automated gate commands**

Add the Extension Host integration gate after unit tests:

```powershell
corepack pnpm test:integration
```

Keep build, test, typecheck, lint, and web-ext lint commands.

- [ ] **Step 3: Run focused regression suites**

Run:

```powershell
corepack pnpm --filter @browser2ide/protocol test
corepack pnpm --filter @browser2ide/plugin-api test
corepack pnpm --filter browser2ide-firefox test
corepack pnpm --filter browser2ide-vscode test
```

Expected: every package suite exits 0.

- [ ] **Step 4: Run the complete automated gate**

Run each command separately and read its exit code:

```powershell
corepack pnpm install
corepack pnpm build
corepack pnpm test
corepack pnpm test:integration
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm dlx web-ext@10.4.0 lint --source-dir extensions/firefox --ignore-files package.json pnpm-lock.yaml tsconfig.json esbuild.mjs "src/**" "test/**"
git diff --check
```

Expected: every command exits 0; web-ext reports 0 errors, warnings, and
notices; `git diff --check` reports no whitespace errors.

- [ ] **Step 5: Perform the manual Firefox-to-VS Code runbook**

Follow `docs/mvp-verification.md` from start to cleanup. Record actual evidence
for these assertions before declaring completion:

```text
No files opened automatically.
Selected and immediate-parent blocks used distinct decorations.
Switching layout.scss -> card.scss -> app.css reused the same DOM selection.
Applicable Sources contained only the active file.
No stale decoration remained on an unsupported file.
```

- [ ] **Step 6: Request final code review**

Dispatch a fresh reviewer with the approved design spec, this plan, base commit,
and final commit range. Fix every Critical or Important finding and rerun the
affected focused suite plus the complete gate.

- [ ] **Step 7: Commit final runbook adjustments**

```powershell
git add docs/mvp-usage.md docs/mvp-verification.md examples/basic-css
git commit -m "docs: verify document-first source flow"
```

## Completion Checklist

- [ ] Protocol v1 is rejected and all repository clients emit protocol v2.
- [ ] Inspect messages contain one selected target and at most one immediate parent.
- [ ] Namespaced runtime facts are strict JSON envelopes.
- [ ] `@browser2ide/plugin-api` builds and passes its public export check.
- [ ] Built-in and external plugins register through the same API.
- [ ] Only active-document-compatible plugins run.
- [ ] CSS and SCSS return every complete applicable block.
- [ ] Parent matches use a distinct semantic decoration and selected wins overlap.
- [ ] Browser2IDE never opens a file in response to inspect.
- [ ] Editor switching reuses the retained DOM selection.
- [ ] Exceptions, invalid ranges, cancellation, and timeout leave no stale highlights.
- [ ] The external fixture passes in a real Extension Host.
- [ ] Future plugin instructions state their actual evidence requirements.
- [ ] Unit, integration, build, typecheck, lint, web-ext lint, and manual runbook pass.
