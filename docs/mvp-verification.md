# Browser2IDE MVP Verification

This runbook verifies the Firefox -> WebSocket bridge -> VS Code development
workflow. HTTP is used only to serve the inspected fixture and its CSS
resources. Browser2IDE product traffic remains WebSocket-only.

Normal use with installed extensions is terminal-free: VS Code starts the
bridge after startup, and the user links Firefox with the status-bar code. This
runbook is contributor-only and intentionally uses an Extension Development
Host, `web-ext`, and a local fixture because it verifies an uninstalled source
checkout. Installed, terminal-free artifact verification is not performed
here; it will be added and executed in Plan 3 as part of the distribution
workflow.

This Plan 1 runbook verifies explicit routing to a VS Code window, but not yet
strict Firefox-window isolation. The current Firefox adapter stores one saved
link per extension profile. Window-scoped browser storage and independent
links for simultaneous Firefox windows are implemented in Plan 2.

## Prerequisites

- Node.js 22 or newer;
- pnpm through Corepack;
- VS Code;
- Firefox Stable 142 or newer.

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

## Start Two VS Code Windows

Build once, then launch an Extension Development Host from terminal 2:

```powershell
corepack pnpm build
code --new-window --extensionDevelopmentPath="$PWD/extensions/vscode" "$PWD"
```

Launch a second Extension Development Host from terminal 3:

```powershell
code --new-window --extensionDevelopmentPath="$PWD/extensions/vscode" "$PWD"
```

Call the first development window Window A and the second Window B.

In both windows:

1. Wait for startup to finish. No Browser2IDE start command should be needed.
2. Confirm the status bar shows a grouped code such as
   `Browser2IDE: 48735 07`.
3. Confirm each window has a different port and therefore a distinct code.
   Each bridge chooses the first free port in `48735..48834`.
4. Confirm an adjacent stop icon is visible.

In Window A:

1. Open `examples/basic-css/src/layout.scss` and keep it active.
2. Open the Browser2IDE Activity Bar container and keep `Applicable Sources`
   visible.
3. Click the grouped status-bar code. Do not run a separate command.
4. Paste temporarily into the Firefox field in the next section and confirm
   the clipboard contains exactly seven digits with no space.
5. Note the currently open editor tabs so unexpected automatic opening is
   visible.

In Window B, keep a source editor visible but do not copy its code. The Firefox
panel must not discover or attach to this window automatically.

## Start Firefox

In terminal 4 on Windows:

```powershell
corepack pnpm dlx web-ext@10.4.0 run --source-dir extensions/firefox --firefox "C:\Program Files\Mozilla Firefox\firefox.exe" --start-url http://127.0.0.1:4173/
```

When `firefox` is already on `PATH`, omit the `--firefox` option.

In Firefox:

1. Open DevTools with `F12`.
2. Open the `Browser2IDE` DevTools panel.
3. Confirm the initial state is `Not linked`. There is no bridge URL field and
   no automatic IDE selection.
4. Paste Window A's seven-digit code into `Link code`.
5. Click `Link`.
6. Confirm the panel state becomes `Linked`.
7. Confirm Firefox diagnostics show Window A's endpoint, session, and bridge
   instance, but no PIN, link code, or token.
8. Enable `Inspect mode`.
9. Click the padding or background of the `.card.featured` article, not its
   inner heading or paragraph.

## Verify Explicit Window Routing

Run `Browser2IDE: Open Diagnostics` in both VS Code windows.

Window A must report:

- `bridge=running` and `client=connected`;
- the endpoint and port encoded by the code used in Firefox;
- `browsers=1`;
- a nonzero latest inspect time, target count, and fact count;
- no unexpected protocol error.

Window B must report:

- its own running bridge, endpoint, port, and instance;
- `browsers=0`;
- no inspect received from the Firefox selection.

Window B must not gain decorations or source matches from that selection.
These checks prove that explicit code entry selected Window A and that no
localhost scan selected another IDE.

## Verify The Active Document

With `src/layout.scss` still active in Window A, verify:

- no additional file or editor tab opens after the DOM selection;
- the complete `.layout > .card` block is highlighted as Selected;
- the complete `.layout` block is highlighted with the distinct Parent
  decoration;
- both blocks, including their closing braces, appear in `Applicable Sources`;
- the list labels them `Selected` and `Parent` and contains source matches only
  for `layout.scss`;
- clicking either match reveals that block in the same active editor.

Run `Browser2IDE: Open Diagnostics` in Window A again and verify:

- bridge and IDE client remain connected;
- the linked-browser count is one;
- the latest inspect timestamp is present;
- two targets and a nonzero fact count were received;
- the active document has nonzero source matches;
- no unexpected protocol error is present;
- the output contains no link code, PIN, or auth token.

Firefox must show the selected-element summary and updated values for matched
CSS facts, inaccessible stylesheets, last sent message, and last error.

## Reuse The Selection

Do not click the page again during these Window A checks:

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
DOM selection, multiple related blocks can be highlighted in one active file,
and stale decoration does not remain on an unsupported file.

## Verify Restart Invalidation

1. Save Window A's current seven-digit code for this test.
2. Click Window A's adjacent stop icon. Confirm the status changes to
   `Browser2IDE: Offline` and the adjacent control becomes a play icon.
3. Confirm Firefox leaves `Linked`, disables inspect mode, and attempts only
   the previously saved endpoint. It must not attach to Window B.
4. Click the play icon in Window A. Confirm a grouped code appears again and
   VS Code diagnostics show a new bridge instance UUID.
5. Compare the first five digits of the old and new codes. They must match so
   this test reaches a new bridge instance at the saved endpoint. If they do
   not, this run proves endpoint isolation only: free the original port and
   restart Window A until it reuses that port before continuing.
6. Firefox's saved token must be rejected for the new instance. Confirm Firefox
   clears the saved link, shows `Not linked`, keeps inspect mode disabled, and
   reports a sanitized saved-link error.
7. Compare the old and new codes. If the random two-digit PIN happened to
   repeat, restart Window A once more before testing the old code.
8. Enter the old code in Firefox and click `Link`. Confirm the bridge rejects
   it without revealing whether the PIN was wrong.
9. Copy Window A's current code from the status bar, link again, and confirm the
   panel returns to `Linked`.

This proves that a reused port does not preserve instance identity or tokens.

## Verify Panel Teardown

1. With Firefox linked again, enable inspect mode and make one selection. Note
   the latest inspect timestamp in Window A diagnostics.
2. Close Firefox DevTools with `F12` while inspect mode is still enabled. This
   destroys the panel and disconnects its owning extension Port.
3. Click the fixture card normally. Window A must receive no new selection and
   its latest inspect timestamp must remain unchanged.
4. Reopen DevTools and the `Browser2IDE` panel. Confirm the saved link
   reconnects to the same endpoint, while inspect mode remains off.
5. Enable inspect mode again and confirm a new card selection reaches Window A.

This verifies that background-owned cleanup survives destruction of the panel
JavaScript context without deleting saved link credentials.

## Verify Unlink

1. Enable inspect mode and make one final selection.
2. Click `Unlink` in Firefox.
3. Confirm inspect mode turns off, link details and selection diagnostics reset,
   and the panel shows `Not linked`.
4. Reload the Browser2IDE panel. It must remain unlinked and must not reconnect
   from removed credentials.
5. In Window A diagnostics, confirm the linked-browser count returns to zero.

## Cleanup

1. Click the stop icon in both VS Code development windows.
2. Close the two Extension Development Host windows.
3. Stop `web-ext` and the fixture server with `Ctrl+C` in their terminals.

## Regenerate CSS

After changing the SCSS fixture, regenerate the committed CSS and source map:

```powershell
corepack pnpm dlx sass@1.89.2 examples/basic-css/src/app.scss examples/basic-css/dist/app.css --style=expanded --source-map --no-error-css
```
