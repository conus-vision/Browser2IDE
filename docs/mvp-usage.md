# Browser2IDE MVP Usage

## Startup Flow

1. Run the VS Code extension host.
2. Run `Browser2IDE: Start`.
3. Run `Browser2IDE: Show Pairing Code`; VS Code creates a fresh short-lived code, copies it, and keeps it visible while focus moves to Firefox.
4. Load the Firefox extension in development mode.
5. Open Firefox DevTools on a local page.
6. Open the Browser2IDE DevTools panel.
7. Paste the pairing code and pair the browser with VS Code.
8. Enable inspect mode in the Browser2IDE panel.
9. Click an element in the inspected page.
10. Verify VS Code opens the related SCSS source when a source map resolves, or generated CSS as a fallback.
11. Verify complete CSS rule ranges are highlighted.
12. Verify the Applicable Rules view lists the matched, heuristic, unmapped, and external rules available for the selected element.

The MVP is Firefox-first. Selection uses Browser2IDE inspect mode inside the Browser2IDE DevTools panel.

## Diagnostics

Run `Browser2IDE: Open Diagnostics` in VS Code to show bridge/client state, pairing expiry, the latest inspect timestamp, fact and reference counts, unmapped sources, external CSS count, and the last protocol error.

The Firefox Browser2IDE panel shows connection and pairing state, the last sent message, the last error, matched CSS fact count, and inaccessible stylesheet count.

## Known Edge Cases

- Cross-origin stylesheets can be reported as inaccessible because Firefox blocks access to their `cssRules`.
- Duplicate selectors can resolve heuristically when the browser does not provide an exact generated range.
- Source maps are detected automatically and original SCSS is preferred. Generated CSS remains the fallback when mapping fails.
- Firefox selection uses Browser2IDE inspect mode instead of a native DevTools Elements selection event.
- The Browser2IDE DevTools panel must remain open for inspect mode and selection events.
