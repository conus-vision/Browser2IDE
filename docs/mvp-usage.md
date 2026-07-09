# Browser2IDE MVP Usage

## Startup Flow

1. Run the VS Code extension host.
2. Run `Browser2IDE: Start`.
3. Copy the short-lived pairing code shown by VS Code.
4. Load the Firefox extension in development mode.
5. Open Firefox DevTools on a local page.
6. Open the Browser2IDE DevTools panel.
7. Enter the pairing code and pair the browser with VS Code.
8. Enable inspect mode in the Browser2IDE panel.
9. Click an element in the inspected page.
10. Verify VS Code opens the related SCSS source when a source map resolves, or generated CSS as a fallback.
11. Verify complete CSS rule ranges are highlighted.
12. Verify the Applicable Rules view lists the matched, heuristic, unmapped, and external rules available for the selected element.

The MVP is Firefox-first. Selection uses Browser2IDE inspect mode inside the Browser2IDE DevTools panel.
