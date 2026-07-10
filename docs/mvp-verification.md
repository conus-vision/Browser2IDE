# Browser2IDE MVP Verification

This runbook verifies the Firefox -> WebSocket bridge -> VS Code workflow. The example uses HTTP only to serve the inspected page and its CSS resources. Browser2IDE product traffic remains WebSocket-only.

## Prerequisites

- Node.js 20 or newer;
- pnpm through Corepack;
- VS Code;
- Firefox 142 or newer.

Run every command from the repository root.

## Automated Gate

```powershell
corepack pnpm install
corepack pnpm build
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm dlx web-ext@10.4.0 lint --source-dir extensions/firefox --ignore-files package.json pnpm-lock.yaml tsconfig.json esbuild.mjs "src/**" "test/**"
```

Every command must exit with code 0. `web-ext` must report zero errors, warnings, and notices.

## Start The Fixture

In terminal 1:

```powershell
node examples/basic-css/server.mjs
```

Keep it running. It prints:

```text
Browser2IDE example: http://127.0.0.1:4173/
```

The server also exposes a CORS-enabled stylesheet on port `4174`. The fixture intentionally provides:

- source-mapped `.card` and `.featured` rules from `card.scss`;
- a source-mapped `.layout > .card` rule from `layout.scss`;
- a local `fallback.css` rule without a source map;
- a same-origin `/virtual.css` rule with no workspace file;
- an external `vendor.css` rule from the second loopback origin.

## Start VS Code

Build first, then launch an Extension Development Host from terminal 2:

```powershell
corepack pnpm build
code --new-window --extensionDevelopmentPath="$PWD/extensions/vscode" "$PWD"
```

In the new VS Code window:

1. Run `Browser2IDE: Start` from the Command Palette.
2. Run `Browser2IDE: Show Pairing Code` and keep the six-digit code visible.
3. Open the Browser2IDE Activity Bar view and keep `Applicable Rules` visible.

If port `48735` is occupied, run `Browser2IDE: Open Diagnostics` and use the fallback bridge URL shown there in the Firefox panel.

## Start Firefox

In terminal 3 on Windows:

```powershell
corepack pnpm dlx web-ext@10.4.0 run --source-dir extensions/firefox --firefox "C:\Program Files\Mozilla Firefox\firefox.exe" --start-url http://127.0.0.1:4173/
```

On systems where `firefox` is already on `PATH`, omit the `--firefox` option.

In Firefox:

1. Open DevTools with `F12`.
2. Open the `Browser2IDE` DevTools panel.
3. Confirm bridge URL `ws://127.0.0.1:48735` and session `default`, unless VS Code diagnostics reported a fallback URL or another configured session.
4. Enter the VS Code pairing code and click `Pair`.
5. Confirm `Connected` and `Paired` are visible.
6. Enable `Inspect mode`.
7. Click the padding or background of the `.card.featured` article, not its inner heading or paragraph.

## Expected Result

VS Code must:

- open `card.scss`, `layout.scss`, and `fallback.css` in non-preview tabs;
- highlight complete rule blocks, not only selector lines;
- show source-mapped entries for `.card`, `.featured`, and `.layout > .card`;
- show `fallback.css` as heuristic;
- keep `/virtual.css` visible as unmapped;
- keep `vendor.css` visible as external;
- navigate to a complete local rule when its `Applicable Rules` item is clicked.

Firefox must update the selected-element summary and diagnostics for matched facts, inaccessible stylesheets, the last sent message, and the last error.

Run `Browser2IDE: Open Diagnostics` in VS Code and verify:

- bridge and IDE client are connected;
- the last inspect timestamp is present;
- fact and resolved-reference counts are nonzero;
- `/virtual.css` appears under unmapped sources;
- external CSS count is nonzero;
- no unexpected protocol error is present.

## Cleanup

1. Disable Firefox inspect mode.
2. Run `Browser2IDE: Stop` in VS Code.
3. Stop `web-ext` and the fixture server with `Ctrl+C` in their terminals.

## Regenerate CSS

After changing the SCSS fixture, regenerate the committed CSS and source map with:

```powershell
corepack pnpm dlx sass@1.89.2 examples/basic-css/src/app.scss examples/basic-css/dist/app.css --style=expanded --source-map --no-error-css
```
