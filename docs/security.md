# Browser2IDE Security

Browser2IDE is a local development tool. The MVP bridge is managed by VS Code and binds to `127.0.0.1` by default.

## Transport

The product exposes no HTTP product API. Browser2IDE product traffic uses WebSocket only:

```text
Firefox extension -> VS Code-managed localhost bridge -> VS Code extension
```

The bridge rejects unexpected WebSocket origins when an origin header is present. Firefox and Chromium extension origins are allowed; originless local clients such as the VS Code extension and simulator are allowed. Ordinary webpage origins are rejected. The bridge is not intended to accept remote network traffic.

## Pairing And Tokens

Pairing codes are short-lived and single-use. The MVP pairing code lifetime is 120 seconds.

Accepted sessions receive random auth tokens. Tokens expire, can be reset from VS Code, and should be treated as secrets. `Browser2IDE: Reset Pairing` invalidates stored authorized tokens for the current session.

VS Code stores authorized browser tokens in SecretStorage. Firefox stores its returned session token in extension storage. Pairing codes are not stored after use.

## Browser Data Collection

The Firefox extension does not collect DOM text content by default.

Allowed browser-sent metadata in the MVP is limited to:

- page URL and origin;
- selected element tag name, ID, classes, and selector candidate;
- safe attributes such as `data-*`, `aria-*`, and `role`;
- stylesheet URLs and accessibility status;
- matched selectors;
- CSS declaration names and rule text needed for source resolution;
- source metadata such as generated line and column when available.

Future adapters and resolvers should keep this data-minimizing shape unless a user explicitly enables richer instrumentation.

## Structured Errors

Protocol errors use a closed, versioned code vocabulary:

- `pairing.invalidCode` and `pairing.expiredCode`;
- `auth.invalidSessionToken`;
- `protocol.invalidMessage`;
- `bridge.noIdeClient` and `bridge.noBrowserClient`;
- `resolver.fileNotFound` and `resolver.sourceMapFailed`;
- `browser.stylesheetInaccessible`.

Pairing codes and auth tokens are never included in error messages or diagnostic metadata.
