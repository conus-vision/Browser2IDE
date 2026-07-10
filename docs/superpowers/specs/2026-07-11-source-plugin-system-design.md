# Browser2IDE Source Plugin System Design

**Date:** 2026-07-11

**Goal:** Replace the CSS-specific, open-all-files MVP presenter with a
document-first source plugin system. The first production plugins resolve CSS
and SCSS rule blocks for the selected DOM element and its immediate DOM parent.

## Scope

This design includes:

- protocol v2 selection targets for the selected element and its immediate
  DOM parent;
- namespaced runtime facts for future plugin ecosystems;
- a public, versioned `@browser2ide/plugin-api` package;
- a public VS Code extension API for registering source plugins;
- document-first dispatch against the active editor only;
- built-in `CssSourcePlugin` and `ScssSourcePlugin` implementations;
- simultaneous highlighting of every matching block in the active editor;
- distinct presentation for selected-element and parent-element matches;
- an `Applicable Sources` view scoped to the active file;
- a real external fixture extension and plugin-authoring documentation;
- Firefox collection of facts for the selected element and its immediate
  parent.

This design does not include:

- backward compatibility with the current protocol or presenter behavior;
- automatic file opening;
- a DOM tree inside the Browser2IDE DevTools panel;
- VS Code approval-based first pairing or automatic browser reconnect UX;
- a Chrome/Chromium adapter;
- production React, Vue, Twig, Blade, PHP, WordPress, or ACF plugins;
- dynamic loading of JavaScript or npm packages from the inspected workspace.

The excluded browser panel, pairing, and Chromium work is a separate phase
built on top of this source plugin foundation.

## Design Principles

1. The browser exports runtime evidence; it does not resolve workspace files.
2. The active VS Code document determines which source plugins run.
3. Plugins return semantic matches, not VS Code decorations or colors.
4. Built-in and external plugins use the same public contract.
5. A plugin failure cannot break other plugins or retain stale highlights.
6. Exact and source-mapped evidence is preferred over selector guessing.
7. Framework source resolution must use source maps or instrumentation when
   final DOM alone cannot identify the source reliably.

## System Architecture

```text
Firefox content script
  -> InspectMessage v2
  -> local WebSocket bridge
  -> VS Code BridgeClient
  -> SelectionStore
  -> ActiveEditorCoordinator
  -> SourcePluginRegistry
  -> matching SourcePlugins
  -> SourceMatch[]
  -> active-editor decorations + Applicable Sources
```

`SelectionStore` retains the latest browser selection independently of which
file is open. `ActiveEditorCoordinator` combines that selection with the active
document and asks `SourcePluginRegistry` to resolve it. The coordinator runs on
these events:

- a new inspect message;
- a change of active text editor;
- a change to the active document, debounced by 150 milliseconds;
- plugin registration or disposal.

No event opens an editor. Switching editors reuses the stored selection and
recomputes matches without another browser click.

## Protocol V2

The base protocol version is increased to `2` for every message type. All
repository clients are migrated together. The old `InspectMessage.subject` and
`InspectMessage.facts` fields are removed rather than normalized.

```ts
interface InspectTarget {
  readonly role: "selected" | "parent";
  readonly depth: 0 | 1;
  readonly subject: InspectSubject;
  readonly facts: readonly RuntimeFact[];
  readonly metadata: JsonObject;
}

interface InspectMessageV2 extends BaseMessageV2 {
  readonly type: "inspect";
  readonly sessionId: string;
  readonly source: ClientSource;
  readonly targets: readonly InspectTarget[];
  readonly context: InspectContext;
}
```

Validation requires exactly one `selected` target with `depth: 0` and permits
at most one `parent` target with `depth: 1`. The parent is omitted when the
selected node has no element parent. No grandparents are collected in this
phase.

Known facts such as `css-rule` and `dom-attribute` retain strict schemas. The
runtime fact union also accepts a strict namespaced extension envelope:

```ts
interface PluginRuntimeFact {
  readonly type: `${string}.${string}`;
  readonly source?: SourceLocation;
  readonly payload: JsonObject;
  readonly metadata: JsonObject;
}
```

Names must contain at least one dot, contain no more than 128 characters, and
each segment must use lowercase ASCII letters, digits, or hyphens. Examples
include `react.component`,
`vue.component`, and `wordpress.acf-block`. Payload and metadata values must be
JSON values. The bridge's message-size limit applies to the complete message.

This phase makes the wire format extensible but does not add a browser-side
third-party fact producer API. Future framework adapters may emit namespaced
facts through a Browser2IDE browser adapter or project instrumentation.

## Public Plugin API

Create a workspace package named `@browser2ide/plugin-api`. It contains plain
TypeScript contracts and depends on `@browser2ide/protocol`, but not on the
`vscode` package. Runtime imports are minimal; plugin implementations can be
tested with Vitest and fake documents/workspaces.

```ts
interface SourcePlugin {
  readonly id: string;
  readonly displayName: string;
  readonly apiVersion: 1;
  readonly documentSelectors: readonly DocumentSelector[];
  readonly supportedFactKinds: readonly string[];
  resolve(context: SourcePluginContext): Promise<SourcePluginResult>;
}

interface DocumentSelector {
  readonly languageId: string;
  readonly scheme?: string;
}

interface SourcePluginContext {
  readonly selection: SelectionSnapshot;
  readonly document: SourceDocument;
  readonly workspace: SourceWorkspace;
  readonly signal: AbortSignal;
}

interface SourcePluginResult {
  readonly matches: readonly SourceMatch[];
  readonly diagnostics?: readonly PluginDiagnostic[];
}

interface SourceMatch {
  readonly targetRole: "selected" | "parent";
  readonly range: SourceRange;
  readonly label: string;
  readonly kind: string;
  readonly relation: string;
  readonly confidence:
    | "exact"
    | "sourcemap"
    | "instrumented"
    | "heuristic"
    | "unknown";
  readonly metadata?: JsonObject;
}
```

`SourceRange` is zero-based and end-exclusive. `SourceDocument` exposes:

- `uri`;
- `languageId`;
- `version`;
- `getText()`;
- `positionAt(offset)`;
- `offsetAt(position)`.

`SourceWorkspace` exposes host-controlled operations needed by resolvers:

- find files inside workspace folders;
- read a workspace text file;
- resolve a browser source URL to unambiguous workspace URI candidates;
- resolve a relative source-map URI;
- report whether a URI belongs to the workspace.

The host abstraction does not provide network fetching or arbitrary module
loading. External VS Code extensions remain trusted extension code and may use
their own VS Code permissions, but Browser2IDE itself never executes workspace
code as a plugin.

## VS Code Extension API

The core extension activation function returns:

```ts
interface Browser2IDEApi {
  readonly apiVersion: 1;
  registerSourcePlugin(plugin: SourcePlugin): Disposable;
}
```

The canonical extension identifier is
`browser2ide.browser2ide-vscode`. External plugin manifests declare it in
`extensionDependencies`, activate the core extension, verify `apiVersion`, and
register their plugin. Registration returns a disposable that unregisters the
plugin and clears any matches owned only by that plugin.

The core registers CSS and SCSS through the same `registerSourcePlugin` method.
Duplicate plugin IDs and incompatible API versions fail registration with an
actionable error.

## Document-First Dispatch

For each resolution generation, the registry:

1. receives the current selection and active document;
2. filters plugins by document language ID and URI scheme;
3. filters out plugins whose supported fact kinds do not occur in any target;
4. invokes every remaining plugin independently;
5. collects successful matches and diagnostics;
6. ignores results from cancelled or superseded generations;
7. rejects results with an unknown target role or a range outside the active
   document and records a plugin diagnostic;
8. deduplicates valid matches;
9. publishes one immutable result for presentation.

Plugins do not have a global priority. When matches share the same active
document range, kind, and relation, the registry chooses the best confidence in
this order:

```text
exact -> sourcemap -> instrumented -> heuristic -> unknown
```

When the same range applies to both targets, `selected` presentation wins over
`parent`. Diagnostics from every contributing plugin remain available.

Each plugin receives the same two-second soft deadline. At the deadline the
host aborts its signal and ignores any later result. JavaScript promises cannot
be forcibly terminated, so plugin guidance requires checking the signal before
and after file reads, parsing, and mapping operations.

## CssSourcePlugin

`CssSourcePlugin` supports `languageId: "css"` and `css-rule` facts.

Resolution algorithm:

1. Group and deduplicate CSS facts separately for selected and parent targets.
2. Resolve each fact's stylesheet URL against the inspected page URL.
3. Require an unambiguous match to the active document URI. A basename-only
   collision is not accepted.
4. Parse the active document once with `postcss`.
5. Locate a rule by browser source position and rule path when available.
6. Fall back to a normalized selector search only when precise evidence is
   absent.
7. Return the complete AST rule range, including selector, declarations, and
   closing brace.

A position-backed match uses `confidence: "exact"`. A selector-only match uses
`confidence: "heuristic"`. Multiple matching rules, including copies in
different media queries, are returned as separate matches. Malformed CSS
returns a parser diagnostic and no stale match.

The plugin caches the parsed AST and rule index by document URI and document
version. A document edit creates a new cache entry and invalidates the previous
one.

## ScssSourcePlugin

`ScssSourcePlugin` supports `languageId: "scss"` and `css-rule` facts.

Resolution algorithm:

1. Group and deduplicate CSS facts separately for selected and parent targets.
2. Resolve the generated CSS file associated with each fact.
3. read its external or inline `sourceMappingURL`;
4. map the generated rule position through the `source-map` package;
5. require the mapped original source to equal the active SCSS document URI;
6. parse the active document once with `postcss-scss`;
7. find the smallest SCSS rule containing the mapped position;
8. return that rule's complete AST range.

The source map chooses the original file and position. The SCSS AST supplies
the full range even when the map contains only selector-level mappings. This
supports nested selectors and imported partials without comparing a compiled
selector to SCSS syntax.

Successful matches use `confidence: "sourcemap"`. Missing, inaccessible, or
invalid maps produce diagnostics and no SCSS selector fallback. Guessing an
SCSS source by selector is explicitly out of scope because nested selectors,
mixins, and generated output make it unsafe.

Parsed SCSS is cached by active document URI and version. Parsed source maps are
cached by map URI and content hash. Cancellation is checked around generated
file reads, map reads, parsing, and each mapping batch.

## Firefox Target Collection

When inspect mode selects an element, the Firefox content script collects:

- an element snapshot and matched runtime facts for the selected element;
- an element snapshot and matched runtime facts for its immediate element
  parent, when present.

Facts are collected independently. A rule that matches both elements may occur
in both targets; target role is preserved through source resolution. Parent
facts mean rules that match the parent element itself. They do not claim that a
declaration is inherited by or otherwise affects the selected child. Existing
inaccessible stylesheet diagnostics remain associated with the inspect message.
Grandparents are not traversed.

## Presentation

The presenter owns colors and VS Code decoration types. Plugins provide only
semantic target roles and source matches.

- Selected-element matches use the primary decoration.
- Parent-element matches use a quieter context decoration with a distinct
  color.
- When roles overlap on the same range, only the primary decoration is shown.
- Every complete matching block in the active editor is decorated.
- Decorations are cleared before publishing a newer generation.
- An unsupported document or an empty result leaves the active editor clean.

The extension contributes theme color IDs for primary and parent highlights so
light and dark themes can define appropriate values. Users can override those
IDs through normal VS Code theme color customization.

Rename the visible tree from `Applicable Rules` to `Applicable Sources` while
keeping its internal view ID stable. The tree contains matches and diagnostics
for the active file only. Each match displays its target role, label, and
confidence. Clicking a match reveals its full range in the already active file;
it never opens another file.

Remove the `browser2ide.openAllReferences` setting and all automatic source
opening behavior.

## Error Handling

- A plugin exception becomes an error diagnostic tagged with its plugin ID.
- An invalid target role or out-of-bounds range from a plugin is discarded and
  becomes a diagnostic instead of reaching the VS Code decoration API.
- Failure of one plugin does not cancel other plugins in the same generation.
- Timeout, cancellation, and stale-generation results never retain decorations.
- CSS and SCSS parser failures identify the active URI and parser message.
- Source-map diagnostics distinguish missing map, unreadable map, invalid map,
  missing original source, and mapping without a position.
- Duplicate or incompatible plugins fail at registration, before resolution.
- Diagnostics are visible in `Applicable Sources` and Browser2IDE diagnostics
  output without exposing pairing tokens or sensitive page content.

## Plugin Authoring Deliverables

Create `docs/source-plugin-authoring.md` with:

- a minimal external VS Code extension manifest;
- activation and core API lookup;
- plugin registration and disposal;
- document selectors and supported fact kinds;
- context, workspace, match, diagnostic, and cancellation examples;
- confidence guidance;
- unit and Extension Host test instructions;
- API compatibility and publishing rules;
- security guidance against evaluating workspace code.

Create a real fixture extension under `extensions/source-plugin-fixture`. It
depends on the core extension, registers through the exported API, returns a
deterministic match for a fixture language ID, and participates in integration
tests.

Add ecosystem recipes that describe required evidence and do not claim
DOM-only exactness where none exists:

- HTML: selector/attribute heuristics for static, unmodified markup;
- JavaScript/TypeScript: source maps and event-listener evidence;
- React: component name, owner chain, and instrumented source location;
- Vue: component instance, file hint, and source map;
- Twig/Blade/PHP: development-only server or build instrumentation;
- WordPress/ACF: block name, PHP template, field group, and source hint;
- custom frameworks: namespaced fact envelope plus source plugin.

Only CSS and SCSS are production implementations in this phase.

## Testing Strategy

### Protocol

- accept one selected target and optional immediate parent;
- reject missing, duplicate, extra, or invalid role/depth target combinations;
- validate known facts strictly;
- accept valid namespaced facts and reject malformed namespaces or non-JSON
  payloads;
- reject protocol v1 inspect messages.

### Plugin Registry

- register and dispose built-in and external plugins;
- reject duplicate IDs and incompatible API versions;
- dispatch by active language ID, scheme, and fact kind;
- isolate plugin exceptions;
- reject invalid target roles and out-of-bounds source ranges;
- enforce soft timeout and cancellation;
- ignore stale generations;
- deduplicate ranges by confidence;
- prefer selected presentation over parent presentation.

### CSS

- return complete blocks for multiple applicable rules;
- distinguish duplicate selectors by position and rule path;
- resolve rules inside media queries;
- use heuristic selector fallback only when needed;
- reject ambiguous source URL mappings;
- report malformed CSS;
- invalidate AST cache after document edits.

### SCSS

- resolve nested rules and imported partials;
- support external and inline source maps;
- return full SCSS blocks from mapped start positions;
- resolve multiple matches in one active file;
- preserve selected and parent roles;
- report missing, invalid, or incomplete maps without heuristic fallback;
- invalidate document and map caches correctly.

### Coordinator And Presentation

- retain selection when no compatible editor is active;
- resolve on inspect, editor switch, document edit, and plugin lifecycle change;
- never open a file;
- clear stale decorations;
- decorate multiple primary and parent ranges with different decoration types;
- keep primary presentation on overlapping ranges;
- scope `Applicable Sources` to the active document.

### Browser And Integration

- collect selected and immediate-parent facts in Firefox;
- omit parent for a root element;
- carry both targets through WebSocket routing unchanged;
- register the external fixture extension through the public API;
- run the repository build, tests, typecheck, lint, and Firefox `web-ext lint`.

## Manual Verification

1. Open an SCSS fixture before selecting an element.
2. Select `.card.featured` in Firefox.
3. Verify that Browser2IDE opens no files.
4. Verify that every matching selected-element SCSS block is highlighted.
5. Verify that immediate-parent rules use the distinct parent decoration.
6. Switch to generated CSS without another browser selection.
7. Verify that CSS matches replace SCSS decorations in the active editor.
8. Switch to an unsupported file and verify that no decorations remain.
9. Switch back to SCSS and verify that the retained selection resolves again.
10. Verify active-file matches and diagnostics in `Applicable Sources`.

## Migration

Backward compatibility is intentionally not required.

- bump the protocol to version 2 and update all repository clients;
- remove the old inspect `subject` and `facts` fields;
- remove `CssRuleResolver` and the current resolve-all registry behavior;
- replace it with the public source plugin registry and two built-in plugins;
- remove automatic file opening and `openAllReferences`;
- rename the visible tree to `Applicable Sources`;
- replace old presenter tests rather than preserving legacy expectations;
- rewrite `docs/mvp-verification.md` for the active-document workflow.

## Acceptance Criteria

The phase is complete when:

- protocol v2 carries selected and optional immediate-parent targets;
- the core extension exports API version 1 and accepts an external fixture
  plugin;
- only plugins compatible with the active document run;
- Browser2IDE never opens files in response to inspect messages;
- CSS and SCSS plugins highlight every complete matching block in the active
  editor;
- selected and parent matches use distinct presentation and selected wins on
  overlap;
- switching files re-resolves the retained selection;
- failures, cancellation, and timeouts cannot leave stale decorations;
- authoring documentation describes realistic paths for the requested future
  ecosystems;
- all automated gates and the updated manual runbook pass.
