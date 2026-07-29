# Browser2IDE Security

Browser2IDE is a local, read-only development tool. Its current model assumes
that the browser extensions and VS Code extension run under the same trusted
desktop user account.

## Transport Boundary

Browser2IDE exposes no HTTP product API. Firefox and Chrome/Chromium use
WebSocket product traffic:

```text
browser extension -> ws://127.0.0.1:<managed-port> -> VS Code extension
```

The bridge binds only to `127.0.0.1` and tries ports `48735..48834`; it never
listens on a LAN or public interface. When an Origin header is present, the
bridge accepts supported Firefox and Chromium extension origins and rejects
ordinary webpage origins. Originless local clients are limited to the IDE and
development tooling. This blocks an inspected webpage from opening the bridge
directly, but it does not defend against a malicious process already running as
the same desktop user.

Chrome/Chromium requires version 116 or newer. Browser2IDE's 15-second bridge
heartbeat both detects dead clients and keeps an authenticated Manifest V3
service-worker WebSocket active under Chrome's supported lifecycle behavior.

## Explicit Browser-Window Selection

Browser2IDE never discovers an IDE automatically. The user copies a seven-digit
code from the intended VS Code window and enters it in a specific browser
window's DevTools panel. The first five digits select one exact loopback port;
the final two digits are that running bridge's PIN.

The browser background owns the mapping. It accepts panel commands only from
the expected extension page, resolves the sender's tab and window itself, and
does not trust panel-supplied window or tab identity. One linked browser window
owns one WebSocket shared by all of its DevTools panels. A different browser
window starts unlinked and cannot reuse that mapping.

`Change IDE` and `Unlink` affect only the current browser window. Closing that
window removes its mapping, credentials, registrations, and socket while other
windows continue independently.

## Code, PIN, And Rate Limit

Every bridge start creates a fresh random two-digit PIN and bridge instance
UUID. Leading zeroes are significant. The PIN remains valid only for that
running bridge instance.

Five failed PIN attempts trigger a bridge-wide 60-second cooldown. The limit is
shared across sockets, so parallel attempts cannot bypass it. Rejection is
generic and does not disclose whether a PIN was close or correct.

The raw code and PIN are ephemeral. The browser does not persist them, and the
panel clears the code field after a successful link and during teardown. The
intentional user-facing exposures are the VS Code status item, the clipboard
after clicking it, and the panel field while linking. Clipboard contents remain
under operating-system control until replaced by the user or another program.

A two-digit PIN is acceptable only for the localhost, read-only MVP:

- the browser exports bounded inspection facts;
- VS Code decorates and reveals source ranges;
- Browser2IDE does not write project or page source;
- Browser2IDE does not execute arbitrary workspace or page commands.

Authentication must be strengthened before enabling writes, arbitrary command
execution, remote transport, or multi-user hosts.

## Credentials And Lifetime

Every bridge start creates a fresh `bridgeInstanceId` and random role-bound
token set. Tokens are bound to a protocol session and bridge instance. Browser,
IDE, and simulator roles cannot exchange tokens. The server-side token registry
and IDE credentials exist only in extension-host memory; stopping the bridge
revokes them and discards the instance identity.

After linking, the browser stores one record per linked browser window in
`browser.storage.session`:

- the exact loopback WebSocket endpoint and port;
- the session ID;
- the bridge instance ID;
- the authenticated browser token.

No browser credential is written to persistent local storage. All panels in the
same browser window reuse this record and its single socket. Closing the window
removes the record; restarting the browser clears all session records. Reopening
DevTools can reconnect the window but never restores Inspect mode.

If saved credentials reach a different bridge instance, expire, or are revoked,
the browser deletes that window's record, disables inspection, and requires a
new explicit code. `Unlink` also revokes the browser token before removing the
record. Merely closing a panel releases that tab's inspect lease but leaves the
window link available to its other tabs.

Authenticated messages retain the session and role identity. Per-tab source
IDs are multiplexed over the browser window's socket and are created and bound
to tab/window registrations by the extension background, not by inspected page
data. Invalid, stale, cross-window, and unregistered source routes are rejected
before an inspect message is sent.

## Clipboard Access

The browser extension requests clipboard-read permission for the Paste control.
It calls the clipboard API only in direct response to that explicit user
action. Opening DevTools, opening the panel, linking another tab, or enabling
Inspect mode does not read the clipboard. Clipboard denial leaves manual code
entry available and does not create a link.

## Inspected-Page Host Access

Firefox and Chrome require `<all_urls>` host access because the background must
inject the inspect content script into the arbitrary page currently being
debugged. `activeTab` is not granted merely by opening DevTools, and optional
host declarations would leave ordinary inspected sites unavailable without a
separate permission flow.

The broad match pattern is an injection capability, not automatic activation.
Browser2IDE injects into a tab only when all of these are true:

- its Browser2IDE DevTools panel is open;
- that browser window has been explicitly linked;
- the user has explicitly enabled Inspect mode for the tab.

Turning Inspect off or closing the panel releases the content-script lease.
Browser-protected pages can still deny injection. The extension has no feature
that navigates pages, submits forms, edits DOM/source, reads cookies or
credentials, or executes user-supplied commands.

## Browser Data Collection

The MVP inspects only the selected DOM element and its immediate DOM parent. It
does not collect DOM text content by default. Allowed bounded facts include:

- page URL and origin;
- tag, ID, classes, selector candidates, and safe `data-*`, `aria-*`, or role
  attributes;
- stylesheet URLs and accessibility status;
- matched selectors and CSS declarations needed for source resolution;
- generated positions and development-only namespaced source metadata.

It does not intentionally send cookies, authorization headers, API keys,
nonces, form values, framework state, database records, full DOM text, or
absolute server paths when a relative source identity is sufficient.

## Sensitive Output

Link codes, PINs, and auth tokens must not appear in extension logs, source
plugin metadata, protocol error details, or inspection facts. User-facing
errors use a closed, sanitized vocabulary and never include raw exception text
or inspected page content.

## Resource Bounds

The bridge rejects WebSocket messages larger than 1 MiB before schema
processing. Protocol v3 further limits each inspect envelope to 768 KiB, at
most two targets, 256 facts per target, and bounded strings, attributes, URLs,
routes, selectors, and metadata.

Browser collection reserves 512 KiB for page-controlled facts across the
selected element and parent. Per target it examines at most 256 stylesheets and
4,096 CSS rules, descends at most 32 group-rule levels, reads at most 128
declarations per rule, retains at most 16 media conditions and 64 inaccessible
stylesheet records, and records at most 128 class names. Collection stops when
the fact or byte budget is exhausted.

## Source Plugin Trust Boundary

Browser2IDE never loads executable plugins, npm packages, or configuration from
an inspected workspace. It does not evaluate project code to discover source
mappings.

A source plugin is a separately installed VS Code extension that depends on the
Browser2IDE core and registers through the versioned source-plugin API. It
follows VS Code's extension installation and trust model. Browser2IDE host
services expose constrained document/workspace reads and source resolution;
they do not fetch arbitrary URLs, load workspace modules, or execute workspace
programs. Third-party extensions remain responsible for behavior performed
through their own normal extension-host permissions.

Framework, template, PHP, WordPress, or ACF mappings may eventually require
development-only build/server instrumentation. Such instrumentation must emit
only stable source identity and must never change production responses or
include secrets and user data.
