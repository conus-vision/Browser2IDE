# Browser2IDE MVP Usage

## Startup Flow

1. Start VS Code with the Browser2IDE extension installed or loaded for
   development. The extension starts its localhost bridge automatically after
   activation.
2. Open the source file you want Browser2IDE to inspect. Resolution is always
   scoped to the active editor.
3. Run `Browser2IDE: Show Pairing Code`. VS Code creates a fresh short-lived
   code, copies it, and keeps it visible while focus moves to Firefox.
4. Open Firefox DevTools on the local page and select the Browser2IDE panel.
5. Paste the pairing code and click `Pair`. Pairing also connects the panel.
6. Enable `Inspect mode` and click an element in the page.

`Browser2IDE: Start` remains available as a retry command when the status bar
shows `Browser2IDE: Offline` or `Browser2IDE: Error`. A previously paired
Firefox profile can use `Connect` with its stored token instead of pairing
again.

## Document-First Results

Browser2IDE does not open, close, or switch editor tabs after a DOM selection.
It combines the retained selection with the current editor:

- CSS documents use the built-in CSS source plugin.
- SCSS documents use the built-in SCSS source plugin and source maps.
- Other language IDs remain unhighlighted until a compatible source plugin is
  installed.

Every applicable complete block in the active document is highlighted. Rules
for the selected DOM element use the Selected decoration; rules for its
immediate DOM parent use the distinct Parent decoration. `Applicable Sources`
contains matches and plugin diagnostics for the active document only.

Switching editors reuses the latest DOM selection without another browser
click. Switching to an unsupported document clears Browser2IDE decorations and
source matches. Clicking an `Applicable Sources` match reveals its full range
inside the already active editor and never opens another file.

## Diagnostics

Run `Browser2IDE: Open Diagnostics` in VS Code to show bridge and IDE-client
state, bridge URL, session, pairing expiry, latest inspect time, received target
and fact counts, active-document source matches, plugin diagnostics, and the
last protocol error.

The Firefox panel shows connection and pairing state, the selected-element
summary, matched CSS fact count, inaccessible stylesheet count, last sent
message, and last error.

## Known Edge Cases

- Cross-origin stylesheets can be reported as inaccessible because Firefox may
  block access to their `cssRules`.
- Duplicate CSS selectors use generated source positions or CSSOM rule paths
  when available and a selector heuristic otherwise.
- SCSS resolution requires an external or inline source map. It deliberately
  does not guess nested SCSS selectors when mapping is missing.
- Firefox selection uses Browser2IDE inspect mode instead of a native DevTools
  Inspector selection event.
- The Browser2IDE DevTools panel must remain open for inspect mode and selection
  events.
