# Privacy

Browser2IDE has no analytics, telemetry pipeline, account system, or remote
Browser2IDE service. Browser-to-IDE product traffic from Browser2IDE-operated
components travels only over a loopback WebSocket to the local VS Code window
that the user explicitly linked with a seven-digit code.

## Data Sent To Linked VS Code

For the selected element and its immediate DOM parent, Browser2IDE can send:

- a bounded full page URL, including its route;
- bounded DOM IDs and classes;
- bounded permitted `data-*`, `aria-*`, and `role` names and values;
- bounded CSS rule facts, including the stylesheet `sourceUrl`, selector,
  property/value declaration, optional media conditions, and CSSOM `rulePath`.

These values are size-bounded but not content-redacted. URLs, identifiers,
classes, permitted attribute values, CSS facts, and development source metadata
are application-controlled and may contain secrets, personal data, or other
sensitive application data. Do not enable Inspect on sensitive pages unless
sending those values to the linked local VS Code window is acceptable.

Browser2IDE does not deliberately read or send cookies, request or response
headers, form values, DOM text, or general page content. The browser extension
does not collect or send workspace source-code or text contents, `sourceMappingURL`
directives, source-map references, source maps, or generated CSS line/column
positions. Linked local VS Code uses the stylesheet `sourceUrl` and CSS facts to
discover and read the generated CSS in the workspace, determine matching
generated rule positions, discover its `sourceMappingURL`, and read any inline
or external source map locally. Workspace and source-map contents remain in the
VS Code process. Clipboard contents are read only after the user clicks Paste
in the DevTools panel, and are used only to fill the link-code field.

## Browser Permissions

The browser extensions require these permissions:

| Permission | Purpose |
| --- | --- |
| `<all_urls>` | Required so Browser2IDE can inject its bounded inspect content script into the page the user is debugging. |
| `activeTab` | Declares the browser's temporary user-gesture tab capability; opening DevTools alone does not grant it, so `<all_urls>` remains required for inspected-page injection. |
| `clipboardRead` | Reads a copied seven-digit link code only after the user clicks Paste. |
| `scripting` | Injects the inspect content script when needed. Turning Inspect off or releasing the panel lease disables the Inspect click listener; the injected runtime may remain loaded until the page lifecycle ends. |
| `storage` | Keeps the browser-window link mapping in session storage. |
| `tabs` | Associates DevTools panels and inspected tabs with the correct browser window. |
| `http://127.0.0.1/*` and `http://localhost/*` | Declares local HTTP resource host access. These host permissions do not authorize WebSocket connections. |

Separately, the extension-page Content Security Policy allows `connect-src`
WebSocket connections to `ws://127.0.0.1:*` and `ws://localhost:*`. This CSP
allowance controls access to the loopback bridge; product traffic does not use
a loopback HTTP API.

`<all_urls>` is required rather than optional inspected-page access in the
current alpha. It does not activate inspection by itself. Script injection
occurs only while the inspected tab's Browser2IDE panel is open, its browser
window is linked, and the user has explicitly enabled Inspect. Browser-protected
pages may still deny injection.

## Separately Installed Source Plugins

After Browser2IDE validates a selection, it passes the full selection snapshot
locally to each compatible registered source plugin, including compatible
separately installed plugins. The snapshot includes all selected and parent
targets, subjects, facts, page context, and metadata. Plugins also receive the
active document and workspace discovery/read services.

Separately installed source plugins are trusted third-party VS Code extension
code. They may have their own data handling, network behavior, retention, and
privacy policy. Browser2IDE does not control their behavior or make privacy
commitments on their behalf. Review a plugin and its policy before installing
or enabling it for sensitive workspaces or inspected applications.

## Retention And Sharing

Browser-window mappings use session storage and clear when the window or
browser session ends. The VS Code presenter retains the latest selection for
local source resolution during the current extension runtime. Browser2IDE-operated
components do not sell, upload, share with a remote service, or remotely retain
inspection data, and the Browser2IDE project operates no remote service. These
commitments do not cover separately installed source plugins.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting and
[docs/security.md](docs/security.md) for the implementation trust model.
