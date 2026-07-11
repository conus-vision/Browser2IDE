# Browser2IDE Browser Window Core And Chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move browser ownership from one Firefox DevTools panel to a shared browser-extension core, persist one explicit link per browser window, multiplex all inspected tabs through one background connection, and ship equivalent Firefox and Chrome Manifest V3 builds.

**Architecture:** Pure DOM inspection and protocol code lives in `@browser2ide/browser-extension-core`; Firefox and Chrome entrypoints adapt WebExtension APIs and manifests. A background `WindowConnectionCoordinator` resolves inspected tab IDs to browser window IDs, stores session-only bridge credentials by window, owns one authenticated WebSocket per linked window while DevTools panels are active, and routes selections from every tab without ever discovering another IDE.

**Tech Stack:** Node.js 22, pnpm 9, TypeScript 5.9, Vitest 2, esbuild 0.21, webextension-polyfill 0.12, lucide 0.468+, Firefox WebExtensions MV3, Chrome Extensions MV3.

---

## Execution Preconditions

- Complete `docs/superpowers/plans/2026-07-11-window-linking-runtime.md` first.
- Start this plan with protocol v3, seven-digit Firefox linking, and automatic
  VS Code status controls green.
- Preserve `docs/superpowers/plans/2026-07-09-browser2ide-mvp.md` if it remains
  unrelated and untracked.
- Use branch or worktree `feat/browser-window-core-chrome`.

## Planned File Structure

```text
packages/browser-extension-core/
  package.json
  tsconfig.json
  assets/{panel.html,panel.css,browser2ide.svg}
  src/
    index.ts
    backgroundRouter.ts
    bridgeClient.ts
    browserWindowLinkStore.ts
    collectCssFacts.ts
    devtoolsRuntime.ts
    elementSnapshot.ts
    inspectMode.ts
    inspectPayload.ts
    linkCode.ts
    panelController.ts
    panelDiagnostics.ts
    panelInspectController.ts
    windowConnectionCoordinator.ts
  test/
    *.test.ts

extensions/firefox/
  manifest.json
  src/{background,contentScript,devtools,panel}.ts
  src/{panel.html,panel.css,browser2ide.svg}

extensions/chrome/
  manifest.json
  package.json
  tsconfig.json
  esbuild.mjs
  src/{background,contentScript,devtools,panel}.ts
  src/{panel.html,panel.css,browser2ide.svg}
  test/{manifest,adapter}.test.ts
```

### Task 1: Create The Shared Browser Extension Core Package

**Files:**
- Create: `packages/browser-extension-core/package.json`
- Create: `packages/browser-extension-core/tsconfig.json`
- Create: `packages/browser-extension-core/src/index.ts`
- Move: `extensions/firefox/src/bridgeClient.ts` -> `packages/browser-extension-core/src/bridgeClient.ts`
- Move: `extensions/firefox/src/collectCssFacts.ts` -> `packages/browser-extension-core/src/collectCssFacts.ts`
- Move: `extensions/firefox/src/devtoolsRuntime.ts` -> `packages/browser-extension-core/src/devtoolsRuntime.ts`
- Move: `extensions/firefox/src/elementSnapshot.ts` -> `packages/browser-extension-core/src/elementSnapshot.ts`
- Move: `extensions/firefox/src/inspectMode.ts` -> `packages/browser-extension-core/src/inspectMode.ts`
- Move: `extensions/firefox/src/inspectPayload.ts` -> `packages/browser-extension-core/src/inspectPayload.ts`
- Move: `extensions/firefox/src/panelDiagnostics.ts` -> `packages/browser-extension-core/src/panelDiagnostics.ts`
- Move: `extensions/firefox/src/panelInspectController.ts` -> `packages/browser-extension-core/src/panelInspectController.ts`
- Move: `extensions/firefox/test/pairingClient.test.ts` -> `packages/browser-extension-core/test/bridgeClient.test.ts`
- Move: `extensions/firefox/test/collectCssFacts.test.ts` -> `packages/browser-extension-core/test/collectCssFacts.test.ts`
- Move: `extensions/firefox/test/devtoolsRuntime.test.ts` -> `packages/browser-extension-core/test/devtoolsRuntime.test.ts`
- Move: `extensions/firefox/test/elementSnapshot.test.ts` -> `packages/browser-extension-core/test/elementSnapshot.test.ts`
- Move: `extensions/firefox/test/inspectMode.test.ts` -> `packages/browser-extension-core/test/inspectMode.test.ts`
- Move: `extensions/firefox/test/inspectPayload.test.ts` -> `packages/browser-extension-core/test/inspectPayload.test.ts`
- Move: `extensions/firefox/test/panelDiagnostics.test.ts` -> `packages/browser-extension-core/test/panelDiagnostics.test.ts`
- Move: `extensions/firefox/test/panelInspectController.test.ts` -> `packages/browser-extension-core/test/panelInspectController.test.ts`
- Modify: `extensions/firefox/package.json`
- Modify: `extensions/firefox/src/contentScript.ts`
- Modify: `extensions/firefox/src/devtools.ts`
- Modify: `extensions/firefox/src/panel.ts`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add a failing public core contract test**

Create `packages/browser-extension-core/test/publicExports.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  BrowserBridgeClient,
  createInspectPayload,
  InspectMode,
  registerDevtoolsPanel,
} from "../src/index.js";

describe("browser extension core exports", () => {
  it("exports transport, inspection, and DevTools runtimes", () => {
    expect(BrowserBridgeClient).toBeTypeOf("function");
    expect(createInspectPayload).toBeTypeOf("function");
    expect(InspectMode).toBeTypeOf("function");
    expect(registerDevtoolsPanel).toBeTypeOf("function");
  });
});
```

- [ ] **Step 2: Run the missing package and verify RED**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test
```

Expected: FAIL because the workspace package does not exist.

- [ ] **Step 3: Create package metadata**

Create `package.json`:

```json
{
  "name": "@browser2ide/browser-extension-core",
  "version": "0.2.0",
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
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "lint": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@browser2ide/protocol": "workspace:*"
  }
}
```

Create `tsconfig.json` matching the protocol package with `rootDir: "src"`,
`outDir: "dist"`, and DOM libraries:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 4: Move pure modules and tests without changing behavior**

Use `git mv` for the eight source modules and their corresponding tests.
Create `src/index.ts` with explicit named exports. Update moved test imports from
`../src/...` to the new package paths. Update the four Firefox entrypoints to
import shared behavior from `@browser2ide/browser-extension-core`; keep all
`webextension-polyfill` imports in Firefox.

- [ ] **Step 5: Add the workspace dependency and verify GREEN**

Add `"@browser2ide/browser-extension-core": "workspace:*"` to Firefox. Run:

```powershell
corepack pnpm install
corepack pnpm --filter @browser2ide/browser-extension-core test
corepack pnpm --filter @browser2ide/browser-extension-core build
corepack pnpm --filter browser2ide-firefox test
corepack pnpm --filter browser2ide-firefox build
```

Expected: moved tests and Firefox remain green.

- [ ] **Step 6: Commit the mechanical extraction**

```powershell
git add packages/browser-extension-core extensions/firefox pnpm-lock.yaml
git commit -m "refactor(browser): extract extension core"
```

### Task 2: Add Link-Code Parsing And Browser-Window Session Storage

**Files:**
- Create: `packages/browser-extension-core/src/linkCode.ts`
- Create: `packages/browser-extension-core/src/browserWindowLinkStore.ts`
- Create: `packages/browser-extension-core/test/linkCode.test.ts`
- Create: `packages/browser-extension-core/test/browserWindowLinkStore.test.ts`
- Modify: `packages/browser-extension-core/src/index.ts`
- Delete after migration: `extensions/firefox/src/panelState.ts`
- Delete after migration: `extensions/firefox/test/panelState.test.ts`

- [ ] **Step 1: Write failing link-code tests**

```ts
it.each([
  ["4873507", 48_735, "07"],
  ["48735 07", 48_735, "07"],
  ["48735-07", 48_735, "07"],
])("parses %s", (value, port, pin) => {
  expect(parseLinkCode(value)).toEqual({
    value: "4873507",
    port,
    pin,
    url: `ws://127.0.0.1:${port}`,
  });
});

it.each(["", "487350", "48735070", "9999907", "48735ab"])(
  "rejects %s",
  (value) => expect(() => parseLinkCode(value)).toThrow(),
);
```

- [ ] **Step 2: Write failing window-store tests**

Use a `MemorySessionStorage` implementing `get`, `set`, and `remove`:

```ts
it("isolates links by browser window", async () => {
  const store = new BrowserWindowLinkStore(new MemorySessionStorage());
  await store.save(10, link({ port: 48_735, instanceId: INSTANCE_A }));
  await store.save(20, link({ port: 48_736, instanceId: INSTANCE_B }));
  expect(await store.load(10)).toMatchObject({ bridgeInstanceId: INSTANCE_A });
  expect(await store.load(20)).toMatchObject({ bridgeInstanceId: INSTANCE_B });
});

it("never persists the PIN or raw link code", async () => {
  const storage = new MemorySessionStorage();
  const store = new BrowserWindowLinkStore(storage);
  await store.save(10, link({ port: 48_735, instanceId: INSTANCE_A }));
  expect(JSON.stringify(storage.values)).not.toContain("07");
  expect(JSON.stringify(storage.values)).not.toContain("4873507");
});
```

Add malformed-record, remove, and browser-window-close cases.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test -- linkCode.test.ts browserWindowLinkStore.test.ts
```

Expected: FAIL because parser and store do not exist.

- [ ] **Step 4: Implement exact types and storage keys**

```ts
export interface BrowserWindowLink {
  readonly url: string;
  readonly port: number;
  readonly sessionId: string;
  readonly bridgeInstanceId: string;
  readonly authToken: string;
}

export interface SessionStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}
```

Use key `browser2ide.windowLink.<windowId>`. Validate loaded values with a
strict Zod schema before returning them; remove malformed records. Implement
`parseLinkCode` exactly once in core and remove the intermediate Firefox parser
after adapters use it.

- [ ] **Step 5: Run focused GREEN and commit**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test -- linkCode.test.ts browserWindowLinkStore.test.ts
git add packages/browser-extension-core extensions/firefox
git commit -m "feat(browser): store explicit window links"
```

### Task 3: Move WebSocket Ownership Into WindowConnectionCoordinator

**Files:**
- Create: `packages/browser-extension-core/src/windowConnectionCoordinator.ts`
- Create: `packages/browser-extension-core/test/windowConnectionCoordinator.test.ts`
- Modify: `packages/browser-extension-core/src/bridgeClient.ts`
- Modify: `packages/browser-extension-core/src/index.ts`

- [ ] **Step 1: Write failing coordinator tests**

Use fake client objects and a real `BrowserWindowLinkStore` over memory:

```ts
it("opens one client for all panels in one browser window", async () => {
  const harness = coordinatorHarness();
  await harness.coordinator.linkWindow(10, "4873507", browserSource("firefox"));
  const first = harness.coordinator.registerPanel({ windowId: 10, tabId: 101, sourceId: "p1" });
  const second = harness.coordinator.registerPanel({ windowId: 10, tabId: 102, sourceId: "p2" });
  await harness.flush();
  expect(harness.createdClients).toHaveLength(1);
  first.dispose();
  expect(harness.createdClients[0].disconnectCalls).toBe(0);
  second.dispose();
  expect(harness.createdClients[0].disconnectCalls).toBe(1);
});

it("keeps different windows isolated", async () => {
  const harness = coordinatorHarness();
  await harness.link(10, "4873507");
  await harness.link(20, "4873608");
  expect(harness.clientFor(10).url).toBe("ws://127.0.0.1:48735");
  expect(harness.clientFor(20).url).toBe("ws://127.0.0.1:48736");
});

it("does not follow a reused port after instance rejection", async () => {
  const harness = coordinatorHarness();
  await harness.link(10, "4873507");
  harness.clientFor(10).emitError("auth.instanceChanged");
  expect(await harness.store.load(10)).toBeUndefined();
  expect(harness.state(10)).toBe("offline");
  expect(harness.createdClients).toHaveLength(1);
});
```

Add capped reconnect, unlink revocation, source-ID preservation, and selection
multiplexing tests.

- [ ] **Step 2: Run test and verify RED**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test -- windowConnectionCoordinator.test.ts
```

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 3: Implement the coordinator contract**

```ts
export type BrowserWindowConnectionState =
  | "notLinked"
  | "linking"
  | "linked"
  | "reconnecting"
  | "offline"
  | "rateLimited"
  | "error";

export interface PanelRegistration {
  readonly windowId: number;
  readonly tabId: number;
  readonly sourceId: string;
  readonly onStateChanged?: (state: BrowserWindowConnectionState) => void;
}

export class WindowConnectionCoordinator {
  linkWindow(windowId: number, code: string, source: ClientSource): Promise<void>;
  unlinkWindow(windowId: number): Promise<void>;
  registerPanel(registration: PanelRegistration): { dispose(): void };
  publishInspect(windowId: number, sourceId: string, payload: InspectPayload): boolean;
  state(windowId: number): BrowserWindowConnectionState;
  removeWindow(windowId: number): Promise<void>;
  dispose(): void;
}
```

Keep one internal record per window containing registrations, one client,
reconnect timer, state, and link. A first registration loads session storage and
connects only to that saved endpoint/instance. A final registration disconnects
the socket but retains the store. `auth.instanceChanged` or token rejection
deletes the mapping and never retries. Network close uses capped exponential
backoff while a panel remains registered.

- [ ] **Step 4: Ensure inspect deduplication is source-aware**

Change `InspectPublisher` hashing to include source ID or allocate one publisher
per panel registration. The wire `InspectMessage.source.id` must be the panel's
unique source ID, and page/tab context must remain in metadata so simultaneous
tabs cannot suppress one another.

- [ ] **Step 5: Run coordinator GREEN and commit**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test -- windowConnectionCoordinator.test.ts
corepack pnpm --filter @browser2ide/browser-extension-core typecheck
git add packages/browser-extension-core
git commit -m "feat(browser): coordinate window connections"
```

### Task 4: Route DevTools Panels And Selections Through Background

**Files:**
- Create: `packages/browser-extension-core/src/backgroundRouter.ts`
- Create: `packages/browser-extension-core/test/backgroundRouter.test.ts`
- Modify: `packages/browser-extension-core/src/devtoolsRuntime.ts`
- Modify: `packages/browser-extension-core/test/devtoolsRuntime.test.ts`
- Delete after replacement: `extensions/firefox/src/backgroundRouter.ts`
- Delete after replacement: `extensions/firefox/test/backgroundRouter.test.ts`

- [ ] **Step 1: Write failing background routing tests**

Cover these exact flows:

```ts
it("registers the DevTools channel then resolves its tab window", async () => {
  const harness = backgroundHarness({ tabWindows: { 101: 10 } });
  await harness.route({
    type: "browser2ide.registerDevtools",
    channel: "c1",
    tabId: 101,
    sourceId: "panel-101",
  });
  await harness.connectPanel("c1");
  expect(harness.registrations).toContainEqual({
    channel: "c1", windowId: 10, tabId: 101,
  });
});

it("routes selections by sender tab window and panel source", async () => {
  const harness = backgroundHarness({ tabWindows: { 101: 10 } });
  await harness.route(
    { type: "elementSelected", payload: inspectPayload },
    { tabId: 101, windowId: 10 },
  );
  expect(harness.published).toContainEqual({
    windowId: 10,
    sourceId: expect.any(String),
    payload: inspectPayload,
  });
});
```

Also prove inspect-mode commands stay tab-scoped and a browser window removal
calls `coordinator.removeWindow(windowId)`.

- [ ] **Step 2: Run router tests and verify RED**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test -- backgroundRouter.test.ts devtoolsRuntime.test.ts
```

Expected: FAIL because the Firefox router does not know browser windows or
coordinator state.

- [ ] **Step 3: Implement narrow platform APIs**

`BackgroundRouterApi` must expose `getTab(tabId)`, `executeScript`,
`sendTabMessage`, `sendRuntimeMessage`, session storage, coordinator, runtime
port connections, and a window-removed subscription. Validate every runtime
message with explicit type guards. Never trust a window ID supplied by panel
content; derive it from the inspected tab. The DevTools page registers its
trusted channel/tab pair; the panel opens a named runtime port containing only
that channel. Port disconnect disposes the panel registration so the
coordinator knows when the final DevTools panel closes.

`registerDevtoolsPanel` sends inspected tab ID plus unique channel/source ID in
`browser2ide.registerDevtools` messages. The panel itself never supplies a tab
or window ID.

- [ ] **Step 4: Run routing GREEN and commit**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test -- backgroundRouter.test.ts devtoolsRuntime.test.ts
git add packages/browser-extension-core extensions/firefox
git commit -m "refactor(browser): route through background"
```

### Task 5: Build The Window-Linking DevTools Panel Controller

**Files:**
- Create: `packages/browser-extension-core/src/panelController.ts`
- Create: `packages/browser-extension-core/test/panelController.test.ts`
- Move: `extensions/firefox/src/panel.html` -> `packages/browser-extension-core/assets/panel.html`
- Move: `extensions/firefox/src/panel.css` -> `packages/browser-extension-core/assets/panel.css`
- Move: `extensions/firefox/src/browser2ide.svg` -> `packages/browser-extension-core/assets/browser2ide.svg`
- Modify: `extensions/firefox/src/panel.ts`
- Modify: `extensions/firefox/esbuild.mjs`
- Modify: `extensions/firefox/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Write failing controller tests**

Use fake elements/clipboard/runtime ports:

```ts
it("reads the clipboard only after the paste action", async () => {
  const harness = panelHarness({ clipboard: "48735 07" });
  await harness.initialize();
  expect(harness.clipboardReads).toBe(0);
  await harness.clickPaste();
  expect(harness.clipboardReads).toBe(1);
  expect(harness.sent).toContainEqual({
    type: "browser2ide.linkWindow",
    channel: "c1",
    code: "4873507",
  });
});

it("keeps manual input when clipboard access is denied", async () => {
  const harness = panelHarness({ clipboardError: new Error("denied") });
  await harness.clickPaste();
  expect(harness.linkCodeInput.disabled).toBe(false);
  expect(harness.errorText).toContain("Paste the seven-digit code manually");
});

it("requires explicit change and unlink", async () => {
  const harness = panelHarness({ state: "linked" });
  expect(harness.commands()).toEqual(["change", "unlink"]);
  await harness.clickUnlink();
  expect(harness.sent).toContainEqual({
    type: "browser2ide.unlinkWindow",
    channel: "c1",
  });
});
```

Retain a test that inspect mode is never enabled during initialization.

- [ ] **Step 2: Run controller test and verify RED**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test -- panelController.test.ts
```

Expected: FAIL because panel logic is still a Firefox entrypoint.

- [ ] **Step 3: Implement PanelController**

Inject clipboard read, runtime send/listen, channel, DOM bindings, and
`PanelInspectController`. Render only operational states: Not linked, Linking,
Connected, Reconnecting, Linked IDE offline, Rate limited, and Error. Expose
`Paste link code`, `Change IDE`, `Unlink`, and the explicit inspect toggle.

Use `lucide` `ClipboardPaste`, `Unlink`, `RefreshCw`, and `MousePointer2` icons
through bundled `createIcons`; every icon-only button gets an accessible label
and tooltip. Do not add feature explanations or nested cards.

Install the icon runtime in shared core:

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core add lucide@0.468.0
```

- [ ] **Step 4: Wire Firefox panel entry and assets**

Firefox `panel.ts` adapts `browser.runtime`, `navigator.clipboard.readText`, and
the panel DOM to `PanelController`. Add `clipboardRead` permission to the
Firefox manifest in Task 6. Copy the three common assets from shared core during
the Firefox build. Keep panel CSS compact, ensure all labels fit at 320px width,
and preserve fixed toolbar dimensions.

- [ ] **Step 5: Run panel GREEN and commit**

```powershell
corepack pnpm install
corepack pnpm --filter @browser2ide/browser-extension-core test -- panelController.test.ts
corepack pnpm --filter browser2ide-firefox test
git add packages/browser-extension-core extensions/firefox pnpm-lock.yaml
git commit -m "feat(browser): add window link panel"
```

### Task 6: Convert Firefox Into A Thin Adapter

**Files:**
- Rewrite: `extensions/firefox/src/background.ts`
- Rewrite: `extensions/firefox/src/contentScript.ts`
- Rewrite: `extensions/firefox/src/devtools.ts`
- Rewrite: `extensions/firefox/src/panel.ts`
- Modify: `extensions/firefox/manifest.json`
- Modify: `extensions/firefox/esbuild.mjs`
- Modify: `extensions/firefox/test/manifest.test.ts`
- Create: `extensions/firefox/test/adapter.test.ts`
- Delete obsolete Firefox-only core source/tests after imports move

- [ ] **Step 1: Write failing Firefox adapter and manifest tests**

Require:

```ts
expect(manifest.manifest_version).toBe(3);
expect(manifest.background.scripts).toEqual(["dist/background.js"]);
expect(manifest.permissions).toEqual(expect.arrayContaining([
  "activeTab", "clipboardRead", "scripting", "storage", "tabs",
]));
expect(manifest.host_permissions).toEqual(expect.arrayContaining([
  "ws://127.0.0.1/*", "ws://localhost/*",
]));
expect(manifest.browser_specific_settings.gecko.id)
  .toBe("browser2ide@local");
```

Adapter tests assert each entrypoint calls the corresponding shared runtime with
Firefox API wrappers and no shared core file imports `webextension-polyfill`.

- [ ] **Step 2: Run Firefox tests and verify RED**

```powershell
corepack pnpm --filter browser2ide-firefox test -- manifest.test.ts adapter.test.ts
```

Expected: FAIL because the manifest lacks clipboard/tabs permissions and
entries still own application state.

- [ ] **Step 3: Rewrite the four adapters**

Each entrypoint imports `browser` from `webextension-polyfill`, creates only the
narrow API adapter needed by shared core, starts the runtime, and reports
sanitized errors to `console.error`. The background adapter uses
`browser.storage.session`, `browser.tabs.get`, `browser.windows.onRemoved`,
runtime messages, scripting, and tab messages.

Bundle shared core into Firefox IIFEs and retain source maps. Copy common panel
assets from `packages/browser-extension-core/assets`.

- [ ] **Step 4: Verify Firefox package**

```powershell
corepack pnpm --filter browser2ide-firefox test
corepack pnpm --filter browser2ide-firefox build
corepack pnpm dlx web-ext@10.4.0 lint --source-dir extensions/firefox --ignore-files package.json pnpm-lock.yaml tsconfig.json esbuild.mjs "src/**" "test/**"
```

Expected: all tests pass and web-ext reports zero findings.

- [ ] **Step 5: Commit the Firefox adapter**

```powershell
git add extensions/firefox packages/browser-extension-core
git commit -m "refactor(firefox): use browser core adapter"
```

### Task 7: Add The Chrome Manifest V3 Adapter

**Files:**
- Create: `extensions/chrome/package.json`
- Create: `extensions/chrome/tsconfig.json`
- Create: `extensions/chrome/esbuild.mjs`
- Create: `extensions/chrome/manifest.json`
- Create: `extensions/chrome/src/background.ts`
- Create: `extensions/chrome/src/contentScript.ts`
- Create: `extensions/chrome/src/devtools.ts`
- Create: `extensions/chrome/src/panel.ts`
- Create: `extensions/chrome/test/manifest.test.ts`
- Create: `extensions/chrome/test/adapter.test.ts`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Write failing Chrome manifest tests**

```ts
it("uses a Chrome MV3 service worker and DevTools page", () => {
  expect(manifest).toMatchObject({
    manifest_version: 3,
    devtools_page: "dist/devtools.html",
    background: { service_worker: "dist/background.js" },
  });
  expect(manifest.background).not.toHaveProperty("scripts");
  expect(manifest).not.toHaveProperty("browser_specific_settings");
});

it("declares only required local permissions", () => {
  expect(manifest.permissions).toEqual(expect.arrayContaining([
    "activeTab", "clipboardRead", "scripting", "storage", "tabs",
  ]));
  expect(manifest.content_security_policy.extension_pages)
    .toContain("ws://127.0.0.1:*");
});
```

- [ ] **Step 2: Run the missing Chrome package and verify RED**

```powershell
corepack pnpm --filter browser2ide-chrome test
```

Expected: FAIL because the package does not exist.

- [ ] **Step 3: Create Chrome package and manifest**

Use package name `browser2ide-chrome`, version `0.2.0`, private workspace
package, and the same scripts/dependencies as Firefox plus shared core. The
manifest mirrors Firefox capabilities but uses `background.service_worker`,
omits Gecko settings, and targets local HTTP pages plus loopback WebSockets.

- [ ] **Step 4: Implement thin Chrome adapters**

Use bundled `webextension-polyfill` so adapters expose the same promise-based
API as Firefox. The background service worker starts the shared coordinator and
heartbeat. The other three entrypoints are structurally identical adapters,
not copies of shared business logic.

Build with esbuild target `chrome116`, IIFE output, source maps, and the same
four entry names as Firefox. Copy panel HTML, CSS, and logo from
`packages/browser-extension-core/assets` so browser UI cannot drift.

- [ ] **Step 5: Run Chrome GREEN**

```powershell
corepack pnpm install
corepack pnpm --filter browser2ide-chrome test
corepack pnpm --filter browser2ide-chrome build
```

Expected: Chrome manifest/adapter tests and build pass.

- [ ] **Step 6: Commit Chrome support**

```powershell
git add extensions/chrome pnpm-lock.yaml
git commit -m "feat(chrome): add DevTools adapter"
```

### Task 8: Prove Window Isolation And Cross-Browser Parity

**Files:**
- Create: `packages/browser-extension-core/test/windowWorkflow.test.ts`
- Modify: `docs/mvp-usage.md`
- Modify: `docs/mvp-verification.md`
- Modify: `docs/security.md`

- [ ] **Step 1: Add a complete in-memory workflow test**

The test must create two bridge client fakes, two browser window IDs, and four
tabs. It links window 10 to instance A and window 20 to instance B, registers
tabs 101/102 and 201/202, publishes one selection from every tab, and asserts:

```ts
expect(instanceA.sourceIds).toEqual(["panel-101", "panel-102"]);
expect(instanceB.sourceIds).toEqual(["panel-201", "panel-202"]);
expect(instanceA.sourceIds).not.toContain("panel-201");
expect(instanceB.sourceIds).not.toContain("panel-101");
```

Then close and reopen tab 102's panel and assert it reconnects to A without a
new link. Remove window 10 and assert its mapping is deleted while window 20
remains connected.

- [ ] **Step 2: Run core and browser suites**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test
corepack pnpm --filter browser2ide-firefox test
corepack pnpm --filter browser2ide-chrome test
```

Expected: all suites pass.

- [ ] **Step 3: Update user and security documentation**

Document explicit per-window linking, session-only storage, all-tab reuse,
Change IDE, Unlink, no automatic discovery, clipboard-read user gesture, Chrome
service-worker heartbeat, and browser-window cleanup. Keep inspect mode manual.

- [ ] **Step 4: Run the monorepo and manifest gate**

```powershell
corepack pnpm build
corepack pnpm test
corepack pnpm test:integration
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm dlx web-ext@10.4.0 lint --source-dir extensions/firefox --ignore-files package.json pnpm-lock.yaml tsconfig.json esbuild.mjs "src/**" "test/**"
git diff --check
```

Expected: all commands exit 0 and Firefox lint has zero findings.

- [ ] **Step 5: Perform manual Firefox and Chrome checks**

Use two normal browser windows and two VS Code windows. Explicitly link each
browser window to a different code. Open DevTools on two tabs in each window;
verify all tabs route to their window's chosen VS Code, closing/reopening
DevTools reuses the mapping, and Change IDE/Unlink never affect the other
window. Restart each browser once and record whether session-only mappings are
correctly absent in the new browser process.

- [ ] **Step 6: Request code review and commit docs**

Fix all Critical and Important findings and rerun affected suites plus the full
gate. Then:

```powershell
git add packages/browser-extension-core extensions/firefox extensions/chrome docs pnpm-lock.yaml
git commit -m "docs: verify browser window linking"
```

## Completion Checklist

- [ ] No shared business logic is duplicated between Firefox and Chrome.
- [ ] A new browser window is never linked automatically.
- [ ] Link codes are read only on an explicit paste action with manual fallback.
- [ ] PINs/raw codes are never stored after link acceptance.
- [ ] One WebSocket serves all active DevTools panels in a linked browser window.
- [ ] Source IDs and inspected tab context survive multiplexing.
- [ ] Different browser windows remain isolated.
- [ ] Instance mismatch cannot follow a reused port.
- [ ] Inspect mode remains explicit and closes with DevTools.
- [ ] Firefox and Chrome adapters build and pass the same shared core contract.
- [ ] Unit, integration, manifest, build, lint, and manual parity checks pass.
