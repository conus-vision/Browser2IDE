# Browser2IDE Security

Browser2IDE is a local development tool. Its current security model assumes
that the browser extension and VS Code extension run under the same trusted
desktop user account.

## Transport Boundary

Browser2IDE exposes no HTTP product API. Product traffic uses WebSocket:

```text
Firefox extension -> ws://127.0.0.1:<managed-port> -> VS Code extension
```

The bridge accepts only the exact host `127.0.0.1`. The VS Code extension tries
the first free port from `48735` through `48834`; it never binds to a LAN or
public interface.

When an Origin header is present, the bridge accepts Firefox and Chromium
extension origins and rejects ordinary webpage origins. Originless local
clients are allowed for the VS Code extension and development simulator. This
prevents an inspected webpage from opening a bridge socket directly, but it is
not a defense against another process already running as the same desktop
user.

## Explicit Window Selection

The browser never scans localhost ports and never chooses an IDE window
automatically. A user must copy the seven-digit code from the intended VS Code
window and enter it in Firefox DevTools. The first five digits identify one
exact bridge port; the final two digits are that bridge instance's PIN.

This explicit action prevents accidental cross-linking when several VS Code
windows are open. It is an identity choice, not a strong local-user
authentication mechanism.

## PIN And Rate Limit

Every bridge start creates a new random two-digit PIN and bridge instance UUID.
The PIN preserves a leading zero. It remains valid only for that running bridge
instance.

Five failed PIN attempts within the rolling failure window trigger a
bridge-wide 60-second cooldown. The limit is shared across connections, so
parallel sockets cannot bypass it. Link rejection is generic and does not
reveal whether a PIN was close or correct.

A two-digit PIN is acceptable only for the current localhost, read-only MVP:

- the browser exports inspection facts;
- VS Code decorates and reveals source ranges;
- neither extension edits project files or executes arbitrary workspace or
  page commands as part of this flow.

The PIN and link protocol must be strengthened before enabling source writes,
arbitrary command execution, or remote transport. A malicious process already
running as the same OS user is outside the protection offered by this PIN.

## Instance And Tokens

Every bridge start creates:

- a fresh `bridgeInstanceId`;
- a fresh PIN;
- a fresh role-bound token set.

Tokens are also bound to the session and bridge instance. The current token
issuer uses random 256-bit values with a 24-hour expiry. A token issued for a
browser cannot authenticate as an IDE or simulator.

After authentication, the bridge checks every message field that repeats this
identity. Inspect messages must retain the authenticated session, role, and
source ID; unlink messages must retain the authenticated session. A mismatch
gets the same sanitized fatal invalid-message response as other malformed
protocol input, is not routed, and closes the offending connection.

VS Code and the bridge retain tokens only in extension-host memory. They do not
write tokens to settings, workspace files, global storage, or SecretStorage.
Stopping the bridge revokes all tokens and discards the instance identity.

Firefox saves only the exact endpoint plus the complete `sessionId`,
`bridgeInstanceId`, and browser `authToken` in extension local storage after an
`authenticated` acknowledgement. It never saves the link code or PIN.
Reconnect attempts use only that endpoint and identity; no port discovery is
performed.

If the endpoint now hosts a different bridge instance, or if the token is
expired or revoked, Firefox:

- rejects the saved link;
- clears the saved endpoint and credentials;
- disables inspect mode;
- requires a new explicit link code.

`Unlink` revokes the current browser token, closes its socket, and clears the
saved Firefox credentials. Closing a socket without unlinking does not revoke
the token immediately, so expiry and bridge shutdown remain the final server
boundaries.

## Sensitive Output

The deliberate user-facing PIN exposures are the visible VS Code status-bar
code, the clipboard copy, and the Firefox `Link code` field while linking. The
Firefox field is cleared after successful authentication. Link codes, PINs,
and auth tokens must not appear in:

- VS Code diagnostics or output logs;
- Firefox diagnostics or error text;
- protocol error details;
- runtime facts or source-plugin metadata.

VS Code diagnostics may show bridge state, endpoint, port, session, instance
UUID, browser count, inspect counts, resolver counts, and sanitized error
codes. Firefox diagnostics may show link state, endpoint, session, instance
UUID, selection counts, and sanitized errors.

## Plugin Trust Boundary

Browser2IDE never loads plugin JavaScript, npm packages, configuration modules,
or executable code from an inspected workspace. It does not evaluate project
code to discover source mappings.

An external source plugin is a separately installed VS Code extension. It
declares `browser2ide.browser2ide-vscode` in `extensionDependencies`, activates
the core, checks `SOURCE_PLUGIN_API_VERSION`, and calls
`registerSourcePlugin`. It therefore follows VS Code's normal extension trust
and installation model rather than becoming workspace content.

The Browser2IDE host gives plugins constrained `SourceDocument` and
`SourceWorkspace` services. Host services can read workspace text, find files,
resolve source URIs, and check workspace membership. They do not fetch HTTP or
WebSocket URLs, load arbitrary modules, or execute workspace programs. A
third-party VS Code extension still has its own normal extension-host
permissions and is responsible for its additional behavior.

## Instrumentation

React, Vue, template, PHP, WordPress, and ACF mappings may require build-time or
server-side instrumentation. Instrumentation must be development-only and must
not change production responses.

Emit only source identity needed by a resolver, such as component name, block
name, template URI, generated position, or a stable field ID. Do not send:

- cookies, authorization headers, API keys, nonces, or environment secrets;
- user-entered field values or framework state;
- template context, database records, or full DOM text;
- absolute server paths when a workspace-relative or source-map URI is enough.

Namespaced runtime fact payloads and metadata must contain JSON values.

## Browser Data Collection

The browser extension does not collect DOM text content by default. MVP inspect
targets are limited to the selected element and its immediate DOM parent.

Allowed metadata includes:

- page URL and origin;
- tag, ID, classes, selector candidates, and safe `data-*`, `aria-*`, or role
  attributes;
- stylesheet URLs and accessibility status;
- matched selectors and CSS declarations needed for resolution;
- generated source positions and development-only namespaced source facts.

Future adapters should preserve this data-minimizing shape unless a user
explicitly enables richer local instrumentation.

## Resource Bounds

The bridge rejects WebSocket messages larger than 1 MiB before JSON or protocol
schema processing. The configured ceiling may be lowered but cannot be raised.

Protocol v3 also bounds known inspect data per message:

- the complete serialized inspect envelope is at most 768 KiB, leaving 256 KiB
  below the WebSocket frame ceiling;
- at most 2 targets, 256 facts per target, and 64 subject attributes;
- selectors up to 2,048 characters, names up to 256, IDs up to 1,024, and
  values or text up to 16,384;
- URLs and routes up to 8,192 characters and frame IDs up to 256.

Firefox applies the same wire limits while collecting and reserves 512 KiB for
page-controlled facts and subject attributes across the selected element and
its parent. Per target it examines at most 256 stylesheets and 4,096 CSS rules,
descends at most 32 group-rule levels, reads at most 128 declarations per rule,
retains at most 16 media conditions and 64 inaccessible stylesheet diagnostics,
and records at most 128 class names. Collection stops when either the fact or
byte budget is full. Verbose stylesheet errors remain local to the Firefox
panel; only their count crosses the bridge. Syntax-bearing source URLs are
preserved exactly when valid and within bounds, otherwise their source facts
and diagnostics are omitted. These ceilings accommodate ordinary development
pages while bounding page-controlled traversal and allocation. The 1 MiB frame
limit remains the backstop for arbitrary metadata and namespaced plugin
payloads.

## Structured Errors

Protocol errors use a closed, versioned vocabulary for link, authentication,
invalid-message, routing, browser-access, and resolver failures.
Plugin-specific failures become sanitized diagnostics tagged with the plugin
ID. Errors must describe the failed operation without exposing page content,
link codes, PINs, auth tokens, or application secrets.
