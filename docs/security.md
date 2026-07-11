# Browser2IDE Security

Browser2IDE is a local development tool. The VS Code-managed bridge binds to
`127.0.0.1` by default.

## Transport

The product exposes no HTTP API. Browser2IDE product traffic uses WebSocket:

```text
Firefox or Chromium extension -> localhost bridge -> VS Code extension
```

The bridge rejects unexpected WebSocket origins when an origin header is
present. Firefox and Chromium extension origins are allowed; originless local
clients such as the VS Code extension and simulator are allowed. Ordinary
webpage origins are rejected. The bridge is not intended for remote network
traffic.

## Pairing And Tokens

Pairing codes are short-lived and single-use. The MVP code lifetime is 120
seconds. Accepted sessions receive random expiring auth tokens that can be
reset from VS Code.

VS Code stores authorized browser tokens in SecretStorage. Firefox stores its
session token in extension storage. Pairing codes are not retained after use.
Pairing codes, auth tokens, and session credentials must never appear in plugin
diagnostics, diagnostic metadata, logs, protocol errors, or runtime facts.

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

Namespaced runtime fact payloads and metadata must contain JSON values and are
subject to the complete protocol message-size limit.

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

## Structured Errors

Protocol errors use a closed, versioned vocabulary, including pairing,
authentication, invalid-message, routing, browser-access, and resolver errors.
Plugin-specific failures become sanitized diagnostics tagged with the plugin
ID. They must describe the operation and source kind without exposing page
content, pairing tokens, auth tokens, or application secrets.
