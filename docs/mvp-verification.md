# Browser2IDE Development Host Verification

For installation and terminal-free acceptance of packaged release candidates,
start with the [installed artifact verification guide](installed-verification.md).

This contributor runbook verifies Firefox and Chrome/Chromium against the same
browser-window linking and document-first source workflow. HTTP serves only the
fixture and its CSS resources; Browser2IDE product traffic remains WebSocket.

Normal use with installed extensions is terminal-free. This contributor runbook uses an
Extension Development Host and development-loaded browser extensions because
it tests a source checkout.

## Prerequisites

- Node.js 22 or newer;
- pnpm through Corepack;
- VS Code;
- Firefox Stable 142 or newer;
- Chrome or Chromium 116 or newer.

Run commands from the repository root unless a step says otherwise.

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

`web-ext` must report zero errors, warnings, and notices. The root test command
includes the shared browser core plus both Firefox and Chrome adapter suites.
The focused two-window workflow can also be run alone:

```powershell
corepack pnpm --filter @browser2ide/protocol build
corepack pnpm --filter @browser2ide/browser-extension-core exec vitest run test/windowWorkflow.test.ts
```

On Windows, an active VS Code installer can temporarily hold the stable-channel
update mutex. Let the update finish before rerunning the integration suite.

The packaged Chrome artifact smoke is a separate contributor check:

```powershell
corepack pnpm smoke:chrome-package
```

On Linux it requires a graphical session or Xvfb. Run it from an existing
session with `DISPLAY` or `WAYLAND_DISPLAY` set, or use the repository command
under `xvfb-run -a`. The smoke script refuses to spawn Chrome when neither
display variable is available.

## Build The Development Extensions

Build the workspace once:

```powershell
corepack pnpm build
```

The build creates Firefox and Chrome assets in each extension's `dist`
directory. After browser-source changes, rebuild the affected adapter:

```powershell
corepack pnpm --filter browser2ide-firefox build
corepack pnpm --filter browser2ide-chrome build
```

## Start The Fixture

In terminal 1:

```powershell
node examples/basic-css/server.mjs
```

Keep it running at `http://127.0.0.1:4173/`. The fixture includes source-mapped
rules from `src/card.scss` and `src/layout.scss`, generated `dist/app.css`, CSS
without a source map, and inaccessible stylesheet cases.

## Start Two VS Code Windows

In terminals 2 and 3, launch two Extension Development Hosts:

```powershell
code --new-window --extensionDevelopmentPath="$PWD/extensions/vscode" "$PWD"
```

Call the first window IDE A and the second IDE B. In both windows:

1. Wait for startup; Browser2IDE must start without a command.
2. Confirm the status bar shows a grouped seven-digit code and a stop control.
3. Confirm the two windows use different managed ports and therefore different
   codes.
4. Click each code and record which clipboard value belongs to A and B.

Open `examples/basic-css/src/layout.scss` in IDE A and IDE B. Keep `Applicable
Sources` visible. Do not start Browser2IDE from a terminal.

## Load Firefox For Development

In terminal 4, choose one new disposable profile path for this verification
run, then start Firefox Stable. Keep the same `$firefoxProfile` value for every
Firefox restart in this run:

```powershell
$firefoxProfile = Join-Path $env:TEMP ("browser2ide-plan2-" + [guid]::NewGuid().ToString("N"))
corepack pnpm dlx web-ext@10.4.0 run --source-dir extensions/firefox --firefox "C:\Program Files\Mozilla Firefox\firefox.exe" --firefox-profile "$firefoxProfile" --profile-create-if-missing --keep-profile-changes --start-url http://127.0.0.1:4173/
```

When `firefox` is on `PATH`, omit only the `--firefox` option and its path. The
explicit profile flags are required: a default temporary profile would make a
restart unable to distinguish session-only cleanup from replacement of the
whole profile. Use two normal Firefox windows, not private windows, for the
matrix below.

## Load Chrome For Development

1. Open `chrome://extensions` in Chrome/Chromium 116+.
2. Enable Developer mode.
3. Choose `Load unpacked` and select the repository's `extensions/chrome`
   directory.
4. Open the fixture in two normal browser windows.
5. After rebuilding, use the extension card's Reload action before retesting.

The manifest intentionally requires inspected-page host access. Browser2IDE
still injects nothing until a DevTools panel is open, its window is linked, and
Inspect mode is explicitly enabled.

## Browser Parity Matrix

Run this complete matrix once in Firefox and once in Chrome. Start each browser
run with two normal windows, Browser A and Browser B, and two fixture tabs in
each window.

### Link Explicit Windows

1. In Browser A's first tab, open DevTools and the Browser2IDE panel. Confirm
   `Not linked`; no IDE is chosen automatically.
2. Click Paste while IDE A's code is in the clipboard, or enter it manually,
   then click Link. Confirm `Connected`.
3. In Browser B's first tab, explicitly link IDE B's code in the same way.
4. Confirm a new third browser window starts `Not linked` and close it.
5. Confirm no code or PIN remains in either linked panel's input.

For the manual check, confirm a Paste click reads the current code and links the
window. Clipboard rejection cannot be induced consistently across supported
browsers; the injected-error test verifies that it leaves manual entry enabled
without linking or enabling inspection:

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core exec vitest run test/panelController.test.ts
```

### Reuse Tabs In The Same Window

1. Open DevTools and Browser2IDE in Browser A's second tab. It must become
   connected through Browser A's existing window mapping without code entry.
2. Repeat in Browser B's second tab.
3. Confirm each VS Code window reports one connected browser client, not one
   client per tab. This proves one WebSocket is multiplexed by all panels in a
   linked browser window.
4. Close and reopen DevTools in one second tab. It must reuse the same window
   link, while Inspect mode returns off.
5. Close every Browser2IDE panel in Browser A. IDE A's connected-browser count
   must become zero while Browser A's `storage.session` mapping remains.
6. Reopen one Browser A panel. It must authenticate a new socket from the saved
   window credentials without another code; the count returns to one and
   Inspect mode remains off.

### Prove Cross-Window Isolation

1. Enable Inspect mode in both Browser A tabs and select an element in each.
   Only IDE A may update.
2. Enable Inspect mode in both Browser B tabs and select an element in each.
   Only IDE B may update.
3. Repeat selections in alternating A/B order and confirm no source update
   crosses the browser-window boundary.
4. Leave the Chrome panels connected for at least 45 seconds, then select
   again. Chrome's Manifest V3 service worker must remain usable through the
   bridge's 15-second heartbeat.

### Verify Change IDE And Unlink

1. In Browser A, click Change IDE and link IDE B's code. Browser B must stay
   connected to IDE B throughout; only Browser A's mapping changes.
2. Change Browser A back to IDE A. Browser B must still route to IDE B.
3. Click Unlink in Browser A. Its tabs must become unlinked and Inspect mode
   must turn off, while Browser B continues routing to IDE B.
4. Re-link Browser A to IDE A for the cleanup checks.

### Verify Window And Browser Cleanup

Open the extension background tools before closing a window:

- Firefox: open `about:debugging#/runtime/this-firefox`, find Browser2IDE, and
  select Inspect;
- Chrome: open `chrome://extensions`, find Browser2IDE, and inspect its service
  worker.

In Firefox's background console, list the fixture tabs and session-record keys
only. Do not print record values because they contain the browser auth token:

```js
await browser.tabs.query({}).then((tabs) => tabs.map(({ id, windowId, url }) => ({ id, windowId, url })))
Object.keys(await browser.storage.session.get(null))
```

In Chrome's service-worker console, use the corresponding APIs:

```js
await chrome.tabs.query({}).then((tabs) => tabs.map(({ id, windowId, url }) => ({ id, windowId, url })))
Object.keys(await chrome.storage.session.get(null))
```

Use the tab list to record Browser A's and Browser B's numeric window IDs.
Before cleanup, confirm both exact keys exist:
`browser2ide.windowLink.<BrowserAWindowId>` and
`browser2ide.windowLink.<BrowserBWindowId>`.

1. Run `Browser2IDE: Open Diagnostics` in both IDE windows and confirm each has
   one connected browser client.
2. Close Browser A's entire browser window, then repeat the corresponding
   key-only `Object.keys(...)` query. Confirm the exact old Browser A key is
   absent and Browser B's key remains.
3. Confirm IDE A now has zero connected browser clients while IDE B still has
   one, and verify Browser B continues routing selections to IDE B.
4. Open a replacement browser window. Its Browser2IDE panel must start
   `Not linked`, and its new window ID must have no link key.
5. Before restarting the browser, repeat the key-only query and record every
   remaining `browser2ide.windowLink.*` key.
6. For Firefox, close all Firefox windows, stop `web-ext`, and rerun the exact
   launch command with the unchanged `$firefoxProfile` and all three profile
   flags. For Chrome, close the complete browser process and reopen the same
   browser profile.
7. Reopen the extension background tools and repeat the key-only query. None
   of the previously recorded window-link keys may remain, proving credentials
   were session-only rather than removed by replacing the profile.
8. Reopen a Browser2IDE panel without linking. It must show `Not linked`,
   Inspect mode must remain off, and no source update may be sent.

## Verify Document-First Highlighting

Perform these checks while a browser window is linked to IDE A. Enable Inspect
mode and select the padding or background of the fixture's `.card.featured`
article.

With `src/layout.scss` active in IDE A, verify:

- no editor tab opens or switches automatically;
- the complete `.layout > .card` block is highlighted as Selected;
- the complete `.layout` block for the immediate DOM parent uses the distinct
  Parent decoration;
- both ranges include their closing braces and appear in `Applicable Sources`;
- selecting a result reveals the range in the already active editor.

Without selecting the page again:

1. Switch to `src/card.scss`; complete `.card` and `.featured` blocks must be
   highlighted as Selected.
2. Switch to `dist/app.css`; generated CSS blocks must be highlighted with
   selected and immediate-parent decorations kept distinct.
3. Switch to `index.html`; built-in plugins do not support the document, so
   decorations and matches must clear.

This proves document-first dispatch, multiple ranges in one CSS/SCSS file,
source-map preference for SCSS, and stale-highlight cleanup.

## Verify VS Code Stop And Start

1. Click IDE A's stop control and confirm its status becomes offline.
2. Browser A must lose its usable connection, turn Inspect mode off, and never
   attach to IDE B.
3. Click play in IDE A. Confirm it receives a fresh code and bridge instance.
4. Enter the new code explicitly and confirm Browser A reconnects.
5. Confirm an old code or saved credential cannot authenticate to the restarted
   bridge.

## Cleanup

1. Disable Inspect mode and unlink remaining browser windows.
2. Stop Browser2IDE in both VS Code development windows.
3. Close the Extension Development Hosts and development-loaded browsers.
4. Stop `web-ext` and the fixture server with `Ctrl+C`.

## Regenerate CSS

After changing the SCSS fixture:

```powershell
corepack pnpm dlx sass@1.89.2 examples/basic-css/src/app.scss examples/basic-css/dist/app.css --style=expanded --source-map --no-error-css
```
