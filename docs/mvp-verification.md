# Browser2IDE MVP Verification

This runbook verifies the Firefox -> WebSocket bridge -> VS Code workflow. HTTP
is used only to serve the inspected fixture and its CSS resources. Browser2IDE
product traffic remains WebSocket-only.

## Prerequisites

- Node.js 22 or newer;
- pnpm through Corepack;
- VS Code;
- Firefox 142 or newer.

Run every command from the repository root.

## Automated Gate

Run each command separately and require exit code 0:

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

`web-ext` must report zero errors, warnings, and notices. On Windows, an active
VS Code installer can temporarily hold the stable-channel update mutex; let the
update finish and rerun `corepack pnpm test:integration`.

## Start The Fixture

In terminal 1:

```powershell
node examples/basic-css/server.mjs
```

Keep it running. It prints:

```text
Browser2IDE example: http://127.0.0.1:4173/
```

The fixture provides:

- source-mapped `.card` and `.featured` rules from `src/card.scss`;
- source-mapped `.layout` and `.layout > .card` rules from `src/layout.scss`;
- generated equivalents in `dist/app.css`;
- local CSS without a source map plus same-origin, external, and inaccessible
  stylesheet cases for resolver and browser diagnostics.

## Start VS Code

Build, then launch an Extension Development Host from terminal 2:

```powershell
corepack pnpm build
code --new-window --extensionDevelopmentPath="$PWD/extensions/vscode" "$PWD"
```

In the new VS Code window:

1. Wait for the status bar to show `Browser2IDE: Connected`. The bridge starts
   automatically when the extension activates. Run `Browser2IDE: Start` only if
   a retry is needed.
2. Open `examples/basic-css/src/layout.scss` and keep it as the active editor.
3. Open the Browser2IDE Activity Bar container and keep `Applicable Sources`
   visible.
4. Run `Browser2IDE: Show Pairing Code`. The command creates a fresh code,
   copies it to the clipboard, and keeps it visible in an input box while VS
   Code loses focus.
5. Note the currently open editor tabs so any unexpected automatic opening is
   visible.

If port `48735` is occupied, run `Browser2IDE: Open Diagnostics` and use the
fallback bridge URL shown there in the Firefox panel.

## Start Firefox

In terminal 3 on Windows:

```powershell
corepack pnpm dlx web-ext@10.4.0 run --source-dir extensions/firefox --firefox "C:\Program Files\Mozilla Firefox\firefox.exe" --start-url http://127.0.0.1:4173/
```

When `firefox` is already on `PATH`, omit the `--firefox` option.

In Firefox:

1. Open DevTools with `F12`.
2. Open the `Browser2IDE` DevTools panel.
3. Confirm bridge URL `ws://127.0.0.1:48735` and session `default`, unless VS
   Code diagnostics reported a fallback URL or configured session.
4. Paste the VS Code pairing code and click `Pair`.
5. Confirm `Connected` and `Paired` are visible.
6. Enable `Inspect mode`.
7. Click the padding or background of the `.card.featured` article, not its
   inner heading or paragraph.

## Verify The Active Document

With `src/layout.scss` still active, verify:

- no additional file or editor tab opens after the DOM selection;
- the complete `.layout > .card` block is highlighted as Selected;
- the complete `.layout` block is highlighted with the distinct Parent
  decoration;
- both blocks, including their closing braces, appear in `Applicable Sources`;
- the list labels them `Selected` and `Parent` and contains source matches only
  for `layout.scss`;
- clicking either match reveals that block in the same active editor.

Run `Browser2IDE: Open Diagnostics` while `layout.scss` is active and verify:

- bridge and IDE client are connected;
- the latest inspect timestamp is present;
- two targets and a nonzero fact count were received;
- the active document has nonzero source matches;
- no unexpected protocol error is present.

Firefox must show the selected-element summary and updated values for matched
facts, inaccessible stylesheets, last sent message, and last error.

## Reuse The Selection

Do not click the page again during these checks:

1. Manually switch to `examples/basic-css/src/card.scss`. Verify the complete
   `.card` and `.featured` blocks are highlighted as Selected and `Applicable
   Sources` now contains only `card.scss` matches.
2. Manually switch to `examples/basic-css/dist/app.css`. Verify the SCSS
   decorations are removed and complete generated CSS blocks are highlighted.
   The `.layout` parent rule and selected-element rules use their distinct
   decorations, and the list contains only `app.css` matches.
3. Manually switch to `examples/basic-css/index.html`. No built-in source plugin
   supports the active HTML document, so all Browser2IDE decorations and source
   matches must clear.

These transitions prove that `layout.scss -> card.scss -> app.css` reused one
DOM selection and that stale decoration did not remain on an unsupported file.

## Cleanup

1. Disable Firefox inspect mode.
2. Run `Browser2IDE: Stop` in VS Code.
3. Stop `web-ext` and the fixture server with `Ctrl+C` in their terminals.

## Regenerate CSS

After changing the SCSS fixture, regenerate the committed CSS and source map:

```powershell
corepack pnpm dlx sass@1.89.2 examples/basic-css/src/app.scss examples/basic-css/dist/app.css --style=expanded --source-map --no-error-css
```
