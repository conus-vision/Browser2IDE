# Browser2IDE MVP Usage

Normal use with the installed VS Code and Firefox extensions requires no
terminal commands. Development from a source checkout is covered separately in
`docs/mvp-verification.md`.

## Start And Link

1. Open the project folder in VS Code.
2. Wait for startup to finish. Browser2IDE activates through
   `onStartupFinished` and starts its localhost bridge automatically.
3. Read the VS Code status-bar item, for example
   `Browser2IDE: 48735 07`.
4. Click that status-bar item. Browser2IDE copies the raw seven-digit code,
   `4873507` in this example, to the clipboard.
5. Open the page in Firefox, open DevTools, and select the `Browser2IDE` panel.
6. Paste the code into `Link code` and click `Link`.
7. Wait for the panel status to become `Linked`.
8. Enable `Inspect mode` and click an element in the page.

The grouped space is only for readability. The Firefox field accepts the
grouped or raw form. Leading zeroes in the two-digit PIN are significant.

The code explicitly chooses one VS Code window. Firefox connects only to the
localhost port encoded in that code; it does not scan for bridges or select an
IDE automatically. When multiple VS Code windows are open, copy the code from
the window that should receive browser selections.

## VS Code Controls

The status bar contains two adjacent Browser2IDE controls:

- click `Browser2IDE: <port> <PIN>` to copy the raw link code;
- click the stop icon to stop the bridge;
- when offline, click the play icon to start a fresh bridge.

The bridge tries the first free port from `48735` through `48834`. A new start
creates a new bridge instance, PIN, and token set. The previous browser token
cannot authenticate to the restarted instance, even when the same port is
reused.

`Browser2IDE: Start`, `Browser2IDE: Stop`, and
`Browser2IDE: Copy Link Code` are also available in the Command Palette. The
normal startup flow does not require running a command manually.

## Firefox Link State

Firefox saves only:

- the exact `ws://127.0.0.1:<port>` endpoint;
- the session ID;
- the bridge instance ID;
- the authenticated browser token.

The code and PIN are not saved. On a later panel load, Firefox reconnects only
to the saved endpoint and verifies the saved instance. It never searches other
ports. If VS Code restarted the bridge, Firefox clears the stale credentials,
turns off inspect mode, and shows that a new link is required.

Click `Unlink` to revoke the current browser token, clear the saved link, reset
panel diagnostics, and disable inspect mode.

## Document-First Results

Browser2IDE does not open, close, or switch editor tabs after a DOM selection.
It combines the retained browser selection with the current VS Code editor:

- CSS documents use the built-in `CssSourcePlugin`;
- SCSS documents use the built-in `ScssSourcePlugin` and source maps;
- other language IDs remain unhighlighted until a compatible source plugin is
  installed.

Every applicable complete block in the active document is highlighted. Rules
for the selected DOM element use the Selected decoration. Rules for its
immediate DOM parent use the distinct Parent decoration. Multiple related
blocks in the same active document can be highlighted at once.

`Applicable Sources` contains matches and plugin diagnostics for the active
document only. Switching editors reuses the latest DOM selection without
another browser click. Switching to an unsupported document clears
Browser2IDE decorations and source matches.

Clicking an `Applicable Sources` match reveals its full range inside the
already active editor and never opens another file.

## Diagnostics

Run `Browser2IDE: Open Diagnostics` in VS Code to show:

- bridge and IDE-client state;
- selected endpoint, port, session, and bridge instance;
- linked-browser count;
- latest inspect time and received target/fact counts;
- active-document source matches and plugin diagnostics;
- the last sanitized protocol error.

The VS Code diagnostics do not expose the link code, PIN, or auth tokens.

The Firefox panel shows:

- link state;
- linked endpoint, session, and bridge instance;
- selected-element summary;
- matched CSS fact and inaccessible stylesheet counts;
- last sent-message time and last error. Protocol errors are displayed through
  the panel's sanitized code-to-message mapping.

Firefox diagnostics do not display the saved token, PIN, or link code.

## Known Edge Cases

- If all 100 managed ports are occupied, Browser2IDE remains offline until a
  port becomes available and the bridge is started again.
- Cross-origin stylesheets can be reported as inaccessible because Firefox may
  block access to their `cssRules`.
- Duplicate CSS selectors use generated source positions or CSSOM rule paths
  when available and a selector heuristic otherwise.
- SCSS resolution requires an external or inline source map. It deliberately
  does not guess nested SCSS selectors when mapping is missing.
- Firefox selection uses Browser2IDE inspect mode instead of a native DevTools
  Inspector selection event.
- The Browser2IDE DevTools panel must remain open for inspect mode and
  selection events in the current Firefox-first MVP.
