# Browser2IDE MVP Usage

Normal use with the installed VS Code and browser extensions is terminal-free.
The commands in `docs/mvp-verification.md` are only for contributors running an
unpackaged source checkout.

## Link A Browser Window

1. Open the project in the VS Code window that should receive selections.
2. Wait for Browser2IDE to start automatically after VS Code startup.
3. Find the status item, for example `Browser2IDE: 48735 07`.
4. Click the status item to copy its seven-digit code, `4873507` in this
   example.
5. In Firefox 142+ or Chrome/Chromium 116+, open DevTools on the page and open
   the `Browser2IDE` panel.
6. Click the Paste icon, or enter the code manually, and select `Link`.
7. Wait for `Connected`, then turn on `Inspect mode`.
8. Select an element in the page.

The displayed space separates the five-digit port from the two-digit PIN. The
field accepts the grouped or ungrouped form, and leading zeroes in the PIN are
significant. Clipboard contents are read only when Paste is clicked. If the
browser denies clipboard access, the field remains available for manual entry.

Entering a code explicitly links one browser window to one VS Code window.
Browser2IDE does not discover IDE instances or probe localhost ports. A newly
opened browser window starts unlinked, even when another window in the same
browser is already connected.

## Window Scope

Each linked browser window owns one session-storage record. While one or more
Browser2IDE DevTools panels are active in that window, they share at most one
active WebSocket, so opening DevTools in additional tabs does not require
another code or socket. Tabs in a different browser window never inherit that
link.

The panel actions are scoped to the current browser window:

- `Change IDE` returns to code entry and lets that window select another VS
  Code window;
- `Unlink` revokes that window's browser token, removes its session record,
  closes its socket, and turns inspect mode off;
- closing a browser window removes its mapping without affecting other windows;
- restarting the browser clears all session-only browser mappings.

Closing or reloading DevTools releases inspect ownership for that tab. When the
last panel in the browser window closes, Browser2IDE disconnects the WebSocket
but retains the session mapping. Reopening a panel authenticates a new socket
from those session credentials without another code. `Inspect mode` stays off;
inspection is always explicit and never resumes automatically.

Firefox Stable 142+ and Chrome/Chromium 116+ use the same shared runtime and
window-linking behavior. Chrome uses a Manifest V3 service worker; the bridge's
15-second heartbeat keeps its authenticated WebSocket active on supported
Chrome versions.

## Panel Controls

The compact DevTools panel reports these operational states:

- `Not linked`;
- `Linking`;
- `Connected`;
- `Reconnecting`;
- `Linked IDE offline`;
- `Rate limited`;
- `Error`.

Before linking, it shows code entry, Paste, and Link. After linking, it shows
Change IDE, Unlink, and the Inspect mode toggle. Inspect is enabled only while
the current panel is connected and is reset when the panel closes, the window
changes IDE, the link is removed, or the connection becomes unusable.

## VS Code Controls

The VS Code status bar has two adjacent Browser2IDE controls:

- click `Browser2IDE: <port> <PIN>` to copy the ungrouped seven-digit code;
- click the stop icon to stop the bridge;
- while offline, click the play icon to start a fresh bridge.

The bridge tries the first free port from `48735` through `48834`. Every start
creates a new PIN, bridge instance, and server-side token set. Saved browser
credentials cannot authenticate to a restarted bridge, even if it reuses the
same port.

`Browser2IDE: Start`, `Browser2IDE: Stop`, and
`Browser2IDE: Copy Link Code` remain available in the Command Palette, but
normal startup does not require running a command.

## Page Access

The browser extension requests `<all_urls>` host access so its background can
inject the bounded inspect content script into whichever page the user is
debugging. The permission does not activate Browser2IDE by itself. Injection
occurs for an inspected tab only after its DevTools panel is open, its browser
window is linked, and the user enables Inspect mode.

The MVP is read-only. It cannot edit page or workspace source, execute arbitrary
commands, or send general page content. It exports bounded inspection facts for
the selected element and its immediate DOM parent. Browser-protected pages can
still reject extension script injection. Full page URLs/routes and permitted
attribute values are size-bounded but not classified or redacted for sensitive
content; see `docs/security.md` before inspecting sensitive pages.

## Document-First Results

Browser2IDE retains the latest browser selection and resolves it against the
document currently active in VS Code. It does not open, close, or switch editor
tabs after a selection.

- CSS documents use the built-in `CssSourcePlugin`.
- SCSS documents use the built-in `ScssSourcePlugin` and available source maps.
- Other language IDs remain unhighlighted until a compatible source plugin is
  installed.

Every applicable complete block in the active document is highlighted. Rules
for the selected DOM element use the Selected decoration; rules for its
immediate DOM parent use the distinct Parent decoration. Several related blocks
in the same file can be highlighted at once.

`Applicable Sources` contains matches and source-plugin diagnostics for the
active document. Switching editors reuses the latest selection. Switching to
an unsupported document clears Browser2IDE decorations and matches. Selecting
a match reveals its complete range in the already active editor and never
opens another file.

## Known Limits

- Cross-origin stylesheets may be inaccessible through browser CSSOM rules.
- Duplicate CSS selectors use generated positions or CSSOM rule paths when
  available and a selector heuristic otherwise.
- SCSS resolution requires an external or inline source map; it does not guess
  nested SCSS selectors when mapping is unavailable.
- If all 100 managed ports are occupied, VS Code remains offline until a port
  becomes available and the bridge is started again.
