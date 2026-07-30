# Browser2IDE

Browser2IDE connects a browser DevTools panel to a local VS Code window and
highlights CSS or source-mapped SCSS rules for an inspected element.

## Install From VSIX

1. Open the Command Palette in VS Code.
2. Run **Extensions: Install from VSIX...**.
3. Select `browser2ide-vscode-0.2.0.vsix` and reload VS Code if prompted.

Browser2IDE starts automatically in each local VS Code window. When ready, the
status bar shows `Browser2IDE: <link code>`; select it to copy the seven-digit
code.

## Link And Inspect

1. Open the Browser2IDE DevTools panel in the browser window you want to link.
2. Paste or enter the VS Code status-bar code, then select **Link**.
3. Explicitly enable **Inspect** in the panel and select an element.

The link belongs to the browser window, so other browser windows must be linked
separately. Inspect mode remains an explicit per-tab action.

To verify CSS, open the matching CSS document in VS Code before inspecting an
element. To verify SCSS, open the original SCSS document and ensure its
generated CSS has an inline or external source map. Browser2IDE highlights
applicable source blocks in the active document.

Source, documentation, and issue tracking are available in the
[Browser2IDE repository](https://github.com/conus-vision/Browser2IDE) and its
[issue tracker](https://github.com/conus-vision/Browser2IDE/issues).
