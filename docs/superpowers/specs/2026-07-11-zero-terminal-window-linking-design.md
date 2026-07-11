# Browser2IDE Zero-Terminal Window Linking And Distribution Design

**Date:** 2026-07-11
**Status:** Approved for implementation planning

## Summary

Browser2IDE will run as a normally installed VS Code extension and normally
installed Firefox or Chrome extension. After the one-time installation, normal
use will not require a terminal, `web-ext`, or an Extension Development Host.

Each VS Code window owns an independent localhost WebSocket bridge. The status
bar displays a seven-digit link code made from that bridge's five-digit port
and a two-digit temporary PIN. A user explicitly copies the code from the VS
Code window they want, opens Browser2IDE DevTools in a browser window, and uses
an explicit paste action to link that browser window. All DevTools instances in
that browser window then reuse only that binding. Browser2IDE never discovers
or silently chooses a different VS Code window.

The first public repository setup will also add installable artifacts, CI,
unlisted Mozilla signing for Firefox Stable, documentation, contribution and
security materials, and an MIT license.

## Implementation Plans

Implementation proceeds in this order:

1. `docs/superpowers/plans/2026-07-11-window-linking-runtime.md`
2. `docs/superpowers/plans/2026-07-11-browser-window-core-and-chrome.md`
3. `docs/superpowers/plans/2026-07-11-distribution-and-repository.md`

## Goals

- Start the managed bridge automatically in every installed VS Code window.
- Provide one-click status-bar copy plus one-click bridge start and stop.
- Remove terminal commands from the normal VS Code, Firefox, and Chrome flow.
- Make the browser-to-IDE choice explicit and scoped to one browser window.
- Share an established binding across every tab in that browser window.
- Support Firefox Stable with a Mozilla-signed, unlisted XPI.
- Support Chrome with a persistent one-time `Load unpacked` installation for
  the MVP.
- Preserve WebSocket-only product traffic and the read-only MVP capability
  boundary.
- Prepare the GitHub repository for contributors and reproducible releases.

## Non-Goals

- Automatically selecting the first available VS Code window.
- Scanning a localhost port range from the browser.
- Keeping a binding after its browser window is closed.
- Keeping a binding after the linked bridge stops or its VS Code window closes.
- Remote bridge access, HTTP product endpoints, or cloud relay services.
- Reverse sync, arbitrary VS Code commands, or source-file writes.
- Public Firefox AMO, Chrome Web Store, or VS Code Marketplace listings in this
  milestone.
- Automatic updates for self-distributed artifacts in this milestone.
- Remote SSH, WSL, Codespaces, or browser-to-remote-extension-host support in
  this milestone. The first packaged release supports local VS Code workspaces.

## User Experience

### VS Code

The installed extension keeps `onStartupFinished` activation. Activation starts
the bridge without a command. Each VS Code window binds the first free port in
the fixed managed range `48735` through `48834`. If all 100 ports are occupied,
the status item enters `Error` and its start action retries the same range.

The extension creates two adjacent status-bar items:

1. A primary item such as `$(radio-tower) Browser2IDE: 48735 42`. Its command
   copies `4873542` to the clipboard and shows a brief confirmation. Its tooltip
   includes the bridge state, URL, session identity, and linked browser-window
   count, but never includes auth tokens.
2. A compact `$(debug-stop)` item while running and `$(play)` item while
   stopped. Its command stops or starts the managed bridge.

`Browser2IDE: Start`, `Browser2IDE: Stop`, diagnostics, and explicit copy
commands remain available as command-palette fallbacks. Starting a stopped
bridge creates a new bridge instance, PIN, and token set. It may reuse the same
port if the port is still available.

### Firefox And Chrome

A newly created browser window begins in `Not linked`. Opening DevTools creates
the Browser2IDE panel but does not choose an IDE. The panel provides an explicit
clipboard icon action named `Paste link code`. On that user gesture, the panel
reads the clipboard, accepts digits with optional spaces or a hyphen, validates
the seven-digit code, and requests a link to the encoded localhost port using
the encoded PIN. The panel also keeps a normal text input as an accessibility
and permission fallback when clipboard access is denied.

After a successful link, every Browser2IDE DevTools panel in that browser
window uses the same mapping. Closing DevTools disconnects idle panel channels
but retains the browser-window mapping. Reopening DevTools reconnects only to
the previously linked bridge instance. It never falls back to a bridge that
happens to reuse the same port.

`Change IDE` explicitly replaces the mapping after a new code is pasted.
`Unlink` closes the window's WebSocket connection, asks the bridge to revoke
the current token when reachable, and deletes the local mapping.

The WebSocket connection is automatic only after this explicit link. Inspect
mode remains an explicit cursor-icon toggle so Browser2IDE does not unexpectedly
intercept normal page clicks. Closing DevTools disables click interception.

## Link Code And Authentication

### Code Format

The managed bridge uses a five-digit port. A cryptographically random PIN from
`00` through `99` is generated when that bridge instance starts. Display uses a
space for readability; clipboard and protocol input use seven digits:

```text
48735 42 -> 4873542
```

The first five digits are the port and the final two digits are the PIN. A PIN
with a leading zero remains two digits. The PIN is stable for the bridge
instance so more than one browser window can be explicitly linked to the same
VS Code window. The PIN is never written to logs, diagnostics, SecretStorage,
or release telemetry.

### Threat Model

The port is routing information, not a secret. The two-digit PIN adds only a
small barrier and is acceptable for this read-only, localhost MVP only when
combined with the following controls:

- bind exclusively to an approved loopback host;
- reject ordinary webpage WebSocket origins;
- validate every message against the versioned protocol schema;
- keep browser and IDE roles separate;
- expose no source writes or arbitrary command execution;
- rate-limit failed PIN attempts bridge-wide;
- issue high-entropy role-bound tokens after a successful link;
- invalidate every token when the bridge instance stops.

Five failed PIN attempts in a rolling 60-second window put link attempts into a
60-second cooldown. The limit is global to the bridge instance so parallel
sockets cannot bypass it. Error responses never reveal whether only the port or
only the PIN was correct.

If Browser2IDE later adds source mutation, reverse sync, browser commands, or
other write capabilities, this two-digit design must be replaced by stronger
pairing or explicit IDE approval before those capabilities ship.

### Bridge Identity And Tokens

Every bridge start creates a random `bridgeInstanceId` independent of the port
and VS Code workspace. A successful PIN link returns that identity plus a
high-entropy browser token. Tokens are held in bridge memory, are role-bound,
and are valid only for that bridge instance.

The browser stores the endpoint, bridge instance ID, and token in extension
session storage under the browser window ID. It never stores the two-digit PIN.
The mapping is deleted when the browser window closes, the user unlinks, or the
bridge reports that the token belongs to a different instance.

If another VS Code window later acquires the same port, the old token fails and
the new `bridgeInstanceId` does not match. The browser displays `Linked IDE is
offline` and requires a new explicit link code instead of pairing silently.

## Runtime Architecture

```text
VS Code window A                       Browser window 10
  bridge 127.0.0.1:48735  <-------->    background connection
  instance A / PIN 42                   tabs 101, 102, 103

VS Code window B                       Browser window 20
  bridge 127.0.0.1:48736  <-------->    background connection
  instance B / PIN 07                   tabs 201, 202
```

### VS Code Components

- `BridgeLifecycleController` owns automatic activation and serialized start,
  stop, and restart transitions.
- `BridgeManager` allocates a managed port, creates a bridge instance identity,
  generates the two-digit PIN, and exposes a sanitized state snapshot.
- `LinkAuthenticator` validates PIN attempts, enforces the global rate limit,
  and issues and revokes in-memory tokens.
- `StatusBarController` renders the primary copy item and start/stop item and
  updates them from lifecycle and client-count events.
- The existing IDE bridge client and source presentation runtime continue to
  consume validated inspect messages.

The packaged extension declares local UI execution for the MVP. Remote
workspaces remain explicitly unsupported until bridge locality and cross-host
source-plugin activation are designed together.

### Browser Components

Shared browser behavior moves into a browser-extension core package. Firefox
and Chrome remain thin adapters with separate manifests and build outputs:

```text
packages/browser-extension-core/
extensions/firefox/
extensions/chrome/
```

The shared core owns link-code parsing, the browser-window mapping store,
reconnection, panel state, inspect collection, diagnostics, and protocol
messages. Platform adapters provide manifest-specific background registration,
DevTools APIs, storage, clipboard access, tabs, windows, and scripting APIs.
Clipboard access is requested only for the explicit paste action and is
documented in the browser privacy and store-submission materials.

Firefox uses its supported Manifest V3 background declaration. Chrome uses a
Manifest V3 service worker. DevTools pages register and unregister inspected
tabs with the background. One browser-window connection multiplexes inspect
messages from all registered tabs in that window. A heartbeat keeps an active
Chrome service-worker WebSocket alive while at least one DevTools panel in the
window is open. When the final panel closes, the socket may close while the
session mapping remains available for a later reconnect.

Each registered DevTools panel receives a unique source ID. Multiplexed inspect
messages preserve that source ID and inspected tab context so deduplication in
one tab cannot suppress a selection from another tab.

### Data Flow

Initial explicit link:

```text
VS Code status item
  -> clipboard: 4873542
  -> DevTools paste action
  -> ws://127.0.0.1:48735
  -> browser link request with PIN 42
  -> rate limit and PIN validation
  -> bridgeInstanceId plus browser token
  -> browser session mapping keyed by browserWindowId
```

Subsequent inspect:

```text
DevTools panel / inspected tab
  -> browser background for its window
  -> authenticated WebSocket
  -> bridge router
  -> IDE client in the linked VS Code window
  -> active-document source plugin
  -> Selected and Parent decorations
```

All product traffic remains WebSocket-only. HTTP may still serve inspected
development pages and their resources, but it is not part of Browser2IDE
transport.

## State And Error Model

VS Code bridge states remain `stopped`, `starting`, `running`, `stopping`, and
`error`. Browser window states become `notLinked`, `linking`, `linked`,
`reconnecting`, `offline`, `rateLimited`, and `error`.

The protocol uses closed structured errors, including:

- `link.invalidCode` for local seven-digit format validation;
- `link.unreachable` when the encoded port cannot be reached;
- `link.rejected` for a generic PIN or link failure;
- `link.rateLimited` with a retry time;
- `auth.tokenRejected` for an invalid or expired token;
- `auth.instanceChanged` when a port now belongs to a different bridge;
- `bridge.offline` after reconnect backoff is exhausted.

Reconnection uses capped exponential backoff only for the saved endpoint and
instance. A token or instance failure stops reconnecting and requires an
explicit new code. Errors are shown in the panel and sanitized diagnostics;
PINs and tokens are excluded.

## Packaging And Installation

The release produces:

- `browser2ide-vscode-<version>.vsix`;
- `browser2ide-chrome-<version>.zip` containing a loadable unpacked directory;
- `browser2ide-firefox-<version>.xpi` signed by Mozilla for unlisted
  self-distribution;
- a Firefox source archive and reproducible build instructions for Mozilla
  review.

Normal installation is one-time and graphical:

1. Install the VSIX with `Extensions: Install from VSIX`.
2. Extract the Chrome ZIP and use `chrome://extensions` -> `Load unpacked` once.
3. Install the signed XPI in Firefox Stable with `Install Add-on From File`.

After installation, opening VS Code starts its bridge and opening DevTools
loads Browser2IDE without terminal commands. Firefox signing uses an existing
Manifest V3 Gecko ID and Mozilla AMO credentials supplied only through GitHub
Actions secrets.

## GitHub Repository And Release Materials

The repository description will be:

> Connect browser DevTools to your IDE and highlight the source code related to
> a selected DOM element.

The project uses the MIT license. The initial public repository adds:

- `README.md` with status, capabilities, screenshots and a short demo GIF
  captured from the verified installed-artifact workflow,
  installation, quick start, architecture, supported platforms, limitations,
  security summary, plugin links, development commands, and roadmap;
- `LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, and `PRIVACY.md`;
- issue forms for bugs and feature requests plus a pull-request template;
- source-plugin authoring and protocol links;
- Firefox source-submission and release instructions;
- repository topics for browser extensions, DevTools, VS Code, WebSocket, CSS,
  SCSS, and source maps.

The empty GitHub repository becomes the `origin` remote only after local
history, release materials, and CI pass. Public push and repository metadata
updates happen after the implementation review so an incomplete installation
path is not advertised as working.

## CI And Release Workflows

Pull requests run on Node.js 22 and require:

- dependency installation from the committed lockfile;
- all package builds;
- unit tests;
- VS Code Extension Host integration tests;
- typecheck and lint;
- Firefox `web-ext lint`;
- Chrome and Firefox manifest validation;
- package smoke tests that load each built manifest and required asset;
- `git diff --check`.

A `v*` tag creates a draft GitHub Release and attaches the VSIX, Chrome ZIP,
unsigned Firefox submission ZIP, source archive, and checksums. A separate
Firefox-signing job uses `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`, calls `web-ext
sign --channel=unlisted`, and attaches the returned signed XPI. The release is
made non-draft only when every required artifact exists. Pull requests and fork
builds never receive AMO secrets and therefore never attempt signing.

## Testing Strategy

### Unit Tests

- Exact seven-digit parsing, optional visual separators, invalid ports, and a
  leading-zero PIN.
- Cryptographic PIN generation and sanitized state snapshots.
- Five-attempt rate limit, cooldown, and resistance to parallel-socket bypass.
- Token creation, role binding, revocation, and bridge-instance invalidation.
- Browser-window mapping creation, lookup, change, unlink, and removal.
- Multiple tabs sharing one mapping and different windows remaining isolated.
- Status-bar copy and start/stop command selection for every lifecycle state.
- Firefox and Chrome adapter contracts against the same shared core suite.
- No sensitive link or token values in diagnostics and errors.

### Integration Tests

- Two VS Code extension hosts allocate different ports and identities.
- Closing one bridge does not affect another.
- Reusing a released port rejects the previous bridge token and identity.
- One browser window multiplexes inspect messages from multiple tabs.
- Two browser windows link independently to two VS Code windows.
- DevTools close and reopen reuses only the saved explicit mapping.
- Active CSS and SCSS document presentation continues to show complete
  Selected and Parent rule ranges after the transport changes.

### Artifact And Manual Verification

- Install the built VSIX in a normal VS Code profile and verify startup without
  an Extension Development Host.
- Load the Chrome artifact once, restart Chrome, and verify it remains
  installed and links without a terminal.
- Install the Mozilla-signed XPI in Firefox Stable, restart Firefox, and verify
  it remains installed and links without `web-ext`.
- Link all tabs in one browser window, verify a second window remains unlinked,
  and then link it to another VS Code window.
- Stop, restart, and close VS Code windows and verify stale mappings never
  attach to a different bridge.
- Verify clipboard copy and explicit paste, manual inspect mode, CSS/SCSS
  source decorations, diagnostics, unlink, and cleanup.

## Documentation Updates

The current development-host runbook remains available for contributors. A new
installed-artifact runbook becomes the primary user verification path. Protocol
and security documents are updated for bridge identity, seven-digit codes,
rate limiting, browser-window mappings, session-only tokens, and the stronger
authentication requirement for any future write capability.

## Success Criteria

- After one-time installation, a user can open VS Code and see a running
  Browser2IDE code without using a terminal.
- Clicking the code copies it and the adjacent status action reliably stops or
  starts the bridge.
- A new browser window links only after the user explicitly pastes that code.
- Every tab in that window reaches the selected VS Code window, while another
  browser window remains independent.
- Reopening DevTools reconnects only to the saved bridge identity.
- Port reuse never silently changes the linked VS Code window.
- Firefox Stable, Chrome, and VS Code artifact installation is documented and
  verified without development launch commands.
- CI passes and a tagged release can produce all required artifacts, including
  a Mozilla-signed unlisted XPI when AMO secrets are configured.
