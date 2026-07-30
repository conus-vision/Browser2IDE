# Privacy

Browser2IDE has no analytics, telemetry pipeline, account system, or remote
Browser2IDE service. Product data travels only over a loopback WebSocket to the
local VS Code window that the user explicitly linked with a seven-digit code.

## Data Sent To Linked VS Code

For the selected element and its immediate DOM parent, Browser2IDE can send:

- a bounded full page URL, including its route;
- bounded DOM IDs and classes;
- bounded permitted `data-*`, `aria-*`, and `role` names and values;
- bounded CSS facts, including matching rule and generated-position details;
- bounded source-map references used to resolve generated CSS to source.

These values are size-bounded but not content-redacted. URLs, identifiers,
classes, permitted attribute values, CSS facts, and development source metadata
are application-controlled and may contain secrets, personal data, or other
sensitive application data. Do not enable Inspect on sensitive pages unless
sending those values to the linked local VS Code window is acceptable.

Browser2IDE does not deliberately read or send cookies, request or response
headers, form values, DOM text, or general page content. The browser extension
does not collect or send workspace source-code or text contents. It sends source
locations and references, including source-map references, so linked local VS
Code can resolve them; workspace file contents remain in the VS Code process.
Clipboard contents are read only after the user clicks Paste in the DevTools
panel, and are used only to fill the link-code field.

## Browser Permissions

The browser extensions require these permissions:

| Permission | Purpose |
| --- | --- |
| `<all_urls>` | Required so Browser2IDE can inject its bounded inspect content script into the page the user is debugging. |
| `activeTab` | Declares the browser's temporary user-gesture tab capability; opening DevTools alone does not grant it, so `<all_urls>` remains required for inspected-page injection. |
| `clipboardRead` | Reads a copied seven-digit link code only after the user clicks Paste. |
| `scripting` | Injects and removes the inspect content script under the activation conditions below. |
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

## Retention And Sharing

Browser-window mappings use session storage and clear when the window or
browser session ends. The VS Code presenter retains the latest selection for
local source resolution during the current extension runtime. Browser2IDE does
not sell, share, upload, or remotely retain inspection data because it has no
remote service.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting and
[docs/security.md](docs/security.md) for the implementation trust model.
