# Browser2IDE Installed Artifact Verification

This is the primary installation and acceptance runbook for Browser2IDE release
candidates. Normal use does not require a Browser2IDE terminal process. Version
`0.2.0` is not published yet, so obtain all candidate files from the repository
owner or a trusted draft release and keep them together with its `SHA256SUMS`.

## Candidate Files

- `browser2ide-vscode-0.2.0.vsix`;
- `browser2ide-chrome-0.2.0.zip`;
- `browser2ide-firefox-0.2.0.xpi`, signed by Mozilla.

The similarly named Firefox ZIP is an unsigned reproducible-build input. It
cannot be persistently installed in Firefox Stable and must not be substituted
for the signed XPI.

## Privacy And Security Before Testing

Browser2IDE is a read-only bridge. Product traffic uses only a loopback
WebSocket between the explicitly linked browser window and local VS Code; it
does not use a remote Browser2IDE service. The browser extension requires
`<all_urls>` so it can inject the bounded inspection content script into the
page being debugged. Injection occurs only while that tab's Browser2IDE DevTools
panel is open, its browser window is linked, and Inspect mode is explicitly
enabled.

The full page URL, including its route, permitted DOM IDs and classes, permitted
`data-*`, `aria-*`, and `role` names and values, plus CSS and development source
metadata may be sent to the linked VS Code window. These
values are bounded but not content-redacted and may contain sensitive
application data. Browser2IDE does not deliberately read cookies, request or
response headers, form values, or DOM text. The browser side does not collect or
send workspace source text. After the inspection metadata reaches local VS Code,
the built-in and any separately installed local VS Code source plugins read
relevant workspace source files and source maps to resolve and highlight source
ranges. Browser2IDE-operated components process those files locally; they are not
uploaded to a remote Browser2IDE service. Separately installed source plugins may
have their own network and data-handling behavior.

Avoid sensitive or private pages unless sending those inspection values to the
linked local VS Code window is acceptable. Trust separately installed
third-party source plugins separately: they receive the validated selection and
run as independent VS Code extension code with their own data-handling behavior.
Read the full [privacy policy](../PRIVACY.md) and
[security policy](../SECURITY.md) before testing sensitive applications.

Use local VS Code, normal non-private browser windows, and a page from a project
whose source is open in VS Code. For SCSS verification, the page's generated CSS
must expose an inline or external source map.

## Install VS Code

1. Open VS Code and choose **Manage > Profiles > Create Profile**.
2. Name the profile `Browser2IDE 0.2.0 Candidate`, create it as an empty profile
   instead of copying an existing profile, and select it. If VS Code does not
   switch automatically, choose it from **Manage > Profiles**.
3. In the dedicated candidate profile, open **Extensions** and confirm no other
   user-installed extensions are enabled.
4. Open the Extensions view menu, choose **Install from VSIX...**, and select
   `browser2ide-vscode-0.2.0.vsix`.
5. Accept the installation prompt and restart VS Code with
   `Browser2IDE 0.2.0 Candidate` still selected.
6. Open a local project folder. Browser2IDE starts automatically after startup.
7. Confirm the status bar shows a radio-tower item such as
   `Browser2IDE: 48735 07` and a separate stop icon.
8. Click the code item. VS Code must report `Browser2IDE link code copied.` The
   clipboard value is the seven digits without the visual space, for example
   `4873507`.

Each VS Code window owns an independent bridge instance and code. Open a second
VS Code window with **File > New Window**, open a local project there, and confirm
its code differs from the first window's code.

## Install Chrome

1. Extract `browser2ide-chrome-0.2.0.zip` into a permanent candidate folder.
   Keep that folder in place while the extension is installed.
2. Open `chrome://extensions` in Chrome or Chromium 116 or newer.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the extracted folder containing
   `manifest.json`.
5. Confirm the Browser2IDE card reports version `0.2.0` with no errors.
6. Close every Chrome window, reopen Chrome, and confirm the Browser2IDE card is
   still present before opening DevTools.

## Install Firefox Stable

This path requires the Mozilla-signed XPI. The unsigned Firefox ZIP is not an
installable substitute.

1. Open Firefox Stable 142 or newer and open the Add-ons Manager.
2. Open its tools menu and choose **Install Add-on From File...**.
3. Select `browser2ide-firefox-0.2.0.xpi` and approve the requested permissions.
4. Confirm Browser2IDE version `0.2.0` appears as enabled.
5. Close every Firefox window, reopen Firefox Stable, and confirm Browser2IDE is
   still enabled before opening DevTools.

## Link Browser Windows

Create two normal browser windows, Browser A and Browser B. A link belongs to a
browser window; it is not chosen automatically and it is not shared with another
browser window.

1. In VS Code A, click the Browser2IDE status code to copy it.
2. In a tab in Browser A, open DevTools and select **Browser2IDE**. The initial
   state must be `Not linked`, and **Inspect mode** must be disabled.
3. Select the clipboard-paste icon. When browser clipboard permission is not
   available, enter the seven-digit code manually. Select **Link**.
4. Confirm the code input is cleared, the panel shows `Connected`, and
   **Inspect mode** becomes available but remains off.
5. Copy the code from VS Code B and explicitly link Browser B to it in the same
   way.
6. Hover each VS Code status item. Each tooltip must report one linked browser
   window. A new third browser window must still begin as `Not linked`.

Open a second tab in each linked browser window and open its Browser2IDE DevTools
panel. It must reuse that window's link without another code. Closing all panels
disconnects the active socket, but reopening a panel in the same browser window
reuses the session link. Inspect mode always returns off.

Use **Change IDE** in Browser A, enter VS Code B's code, and confirm Browser B is
not interrupted. Change Browser A back to VS Code A. Then use the unlink icon in
Browser A: every panel in Browser A must become unlinked and stop inspection,
while Browser B remains connected.

## Inspect Source

Relink Browser A to VS Code A. Keep the relevant CSS or source-mapped SCSS file
active in the editor before selecting an element.

1. Enable **Inspect mode** manually in Browser A and select an element on the
   inspected page.
2. Confirm VS Code does not open or switch editor tabs. Browser2IDE dispatches
   the selection to the source plugin for the current open document.
3. In a CSS file, confirm every applicable complete rule block for the selected
   element is highlighted, including closing braces.
4. In a source-mapped SCSS file, confirm all applicable original SCSS blocks can
   be highlighted in multiple locations.
5. Confirm rules for the selected element use the **Selected** decoration and
   rules for only its immediate DOM parent use the visually distinct **Parent**
   decoration. The default theme uses green for Selected and blue for Parent.
6. Open the Browser2IDE Activity Bar view. **Applicable Sources** must label each
   result `Selected` or `Parent`; selecting a result reveals its complete range
   in the already active editor.
7. Switch between related CSS and SCSS files without selecting the page again.
   The built-in `CssSourcePlugin` or `ScssSourcePlugin` must resolve the active
   document and refresh its ranges.
8. Switch to an unsupported file such as HTML. Decorations and source matches
   must clear. Another installed source plugin may handle its own declared file
   types through the public plugin API.

Alternate selections between Browser A and Browser B. Only the VS Code window
explicitly linked to that browser window may update.

## Start, Stop, And Stale Links

1. Select the stop icon beside VS Code A's status code. The status must pass
   through `Stopping` to `Browser2IDE: Offline`, and the icon becomes Start.
2. Browser A must stop sending selections and show `Linked IDE offline`.
   Browser B and VS Code B must remain connected.
3. Select Start in VS Code A. A new bridge instance and link code must appear.
4. The old browser credential must be rejected rather than silently attaching
   to the new instance. Use **Change IDE** and try the old seven-digit code; the
   link request must fail.
5. Copy the new code from VS Code A and link again. The panel must return to
   `Connected`, with Inspect mode still off until enabled manually.

If all managed ports are unavailable, VS Code remains `Offline`. Use the
Command Palette action **Browser2IDE: Open Diagnostics** to identify the bridge
state; no separate bridge process should be started.

## Cleanup

1. Turn off Inspect mode in every open panel.
2. Select **Unlink** in each browser window and confirm `Not linked`.
3. Close DevTools, then close the browser windows. Browser link credentials are
   session-only and do not survive a complete browser restart.
4. Stop Browser2IDE from each VS Code status item if the test is finished.
5. Remove the candidate extensions from the browser Add-ons/Extensions pages
   and uninstall Browser2IDE from VS Code when the candidate should not remain.

## Expected States

| Action | VS Code | DevTools panel |
| --- | --- | --- |
| Installed VS Code startup | `Browser2IDE: <port> <PIN>` | No automatic link |
| New browser window | Linked count unchanged | `Not linked`; Inspect disabled |
| Successful Link | Tooltip count increases | `Connected`; Inspect available and off |
| Same-window second tab | One browser-window connection | Reuses link; Inspect off initially |
| Different browser window | Only its chosen IDE updates | Requires its own code |
| Stop IDE bridge | `Browser2IDE: Offline` | `Linked IDE offline`; Inspect off |
| Restart IDE bridge | New instance/code | Stale credential rejected; relink required |
| Unlink | Tooltip count decreases | `Not linked`; Inspect disabled |

## Troubleshooting

- **No VS Code code:** confirm Browser2IDE 0.2.0 is enabled, restart VS Code, and
  select the Start icon if the status is `Offline`.
- **Paste does not work:** browser clipboard permission can be denied. Enter the
  same seven digits manually; spaces are optional.
- **Link is rejected:** copy the current code from the intended VS Code window.
  Codes and credentials from a stopped or closed instance are intentionally
  invalid.
- **Wrong VS Code updates:** select **Change IDE** in that browser window and
  explicitly enter the intended window's current code.
- **No Browser2IDE DevTools tab:** verify the browser extension is enabled,
  restart the browser, and reopen DevTools for a normal web page.
- **No highlights:** enable Inspect mode, keep the expected source document
  active, and confirm SCSS has a usable source map. Browser2IDE does not switch
  files automatically.
- **Chrome shows extension errors:** remove the unpacked extension, extract a
  clean candidate ZIP into a stable folder, and use **Load unpacked** again.
- **Firefox rejects the file:** verify the filename ends in `.xpi` and came from
  Mozilla signing. The unsigned `.zip` is expected to be rejected for persistent
  Firefox Stable installation.

## 0.2.0 Candidate Verification Record

Prepared on 2026-07-30. This section distinguishes checks that can run against
packaged artifacts from the terminal-free manual acceptance matrix above. A
marker is evidence only after the exact command exits successfully in the
candidate checkout; expected output is not recorded as an observed result.

Candidate source commit: `15ad8893945048d68314ed0665b38eb2738929c9`.

- `browser2ide-vscode-0.2.0.vsix` SHA-256:
  `f766b5ed7d898747c8af8ee15b7342933f0a4901f40bce058efd08af07e91929`.
- `browser2ide-chrome-0.2.0.zip` SHA-256:
  `0a2126d1df3c957982209f56998fa892187e8030d448275924692d8d7dede34e`.

Observed artifact smoke evidence:

- `corepack pnpm smoke:vscode-package` exited with code 0 on 2026-07-30. It
  installed the actual VSIX into isolated extension and user-data directories,
  activated Browser2IDE 0.2.0, and emitted
  `INSTALLED_VSIX_ACTIVATION_OK browser2ide.browser2ide-vscode`.
- `corepack pnpm smoke:chrome-package` exited with code 0 on 2026-07-30. It
  validated and extracted only the exact Chrome runtime allowlist, launched
  Chrome Stable 150.0.7871.187 with a disposable user-data directory, loaded
  Browser2IDE 0.2.0 through CDP, observed its MV3 service worker, and emitted
  `PACKAGED_CHROME_MV3_OK Chrome/150.0.7871.187 Browser2IDE 0.2.0
  fabfckmgcbokjighbhnningclbckebik/dist/background.js`.

On Linux, the packaged Chrome smoke requires a graphical session or Xvfb. The
script validates that `DISPLAY` or `WAYLAND_DISPLAY` is set before it spawns
Chrome. This platform requirement does not change the observed Windows result
above.

The VSIX smoke uses a tiny Extension Development Host only as the test harness;
Browser2IDE itself is installed from the VSIX under test. The Chrome smoke is
limited to archive validation, isolated-profile loading, manifest identity, and
worker startup. Neither command substitutes for the UI installation and
persistence matrix.

Pending external release evidence:

- install and restart of the Mozilla-signed XPI in Firefox Stable;
- the complete manual two-VS-Code-window and two-browser-window matrix in both
  Firefox Stable and Chrome Stable;
- UI confirmation of status-code copy, stop/start, stale-link recovery, and all
  CSS/SCSS decorations from installed candidates;
- a real privacy-reviewed linking screenshot;
- a real GIF of linking, DOM selection, and Selected/Parent SCSS highlights.

No signed `0.2.0` XPI exists in the candidate artifacts yet. Therefore Firefox
Stable installation is not marked verified, and no screenshot or GIF is present.
