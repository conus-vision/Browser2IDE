# Browser2IDE Protocol

The Browser2IDE protocol carries runtime inspection evidence from browser
adapters to IDE presenters through a local WebSocket bridge. Browser adapters
collect facts; IDE source plugins resolve those facts because only the IDE has
workspace access.

## Version And Envelope

The current protocol version is `3`. Every message is a strict object with:

- `protocolVersion: 3`;
- a non-empty `messageId`;
- a message-specific `type`;
- JSON-only `metadata`.

Implementations reject unsupported versions, unknown fields, and invalid
message shapes instead of guessing or normalizing them.

## Bridge Identity And Link Code

Every bridge start creates a new UUID `bridgeInstanceId`, a two-digit PIN, and
a fresh in-memory token set. The VS Code extension binds the bridge to the
first free port in the managed range `48735` through `48834`.

The seven-digit link code is a user-interface encoding:

```text
48735 07 -> port 48735 + PIN 07 -> 4873507 on the clipboard
```

The grouped form is displayed for readability. The copied form contains only
seven digits. A browser parses the first five digits as the port, connects to
`ws://127.0.0.1:<port>`, and sends only the final two digits as the protocol
PIN. The code is not a protocol message and is never used to scan ports or
select an IDE automatically.

## Link And Authentication

A browser or simulator opens a WebSocket to the exact endpoint encoded in the
link code and sends one `linkRequest` on that connection:

```json
{
  "protocolVersion": 3,
  "type": "linkRequest",
  "messageId": "link-1",
  "pin": "07",
  "source": {
    "role": "browser",
    "id": "firefox-devtools",
    "metadata": {}
  },
  "metadata": {}
}
```

The bridge allows only one link attempt per WebSocket. A successful request
receives the session, bridge instance, role-bound token, and token expiry:

```json
{
  "protocolVersion": 3,
  "type": "linkAccepted",
  "messageId": "link-accepted-1",
  "sessionId": "default",
  "bridgeInstanceId": "2d7856f5-8218-4ba6-9f6c-7aa459333ee1",
  "authToken": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "expiresAt": "2026-07-28T12:00:00.000Z",
  "metadata": {}
}
```

The client must then authenticate before it reports itself as connected:

```json
{
  "protocolVersion": 3,
  "type": "hello",
  "messageId": "hello-1",
  "sessionId": "default",
  "authToken": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "bridgeInstanceId": "2d7856f5-8218-4ba6-9f6c-7aa459333ee1",
  "source": {
    "role": "browser",
    "id": "firefox-devtools",
    "metadata": {}
  },
  "capabilities": ["inspect", "link"],
  "metadata": {}
}
```

The bridge validates the session, client role, token, expiry, and instance
identity, registers the client, and acknowledges the authenticated identity:

```json
{
  "protocolVersion": 3,
  "type": "authenticated",
  "messageId": "authenticated-1",
  "sessionId": "default",
  "bridgeInstanceId": "2d7856f5-8218-4ba6-9f6c-7aa459333ee1",
  "metadata": {}
}
```

The Firefox client stores credentials only after this acknowledgement. It may
then reconnect to the saved endpoint by sending `hello` with the saved session,
instance, and token. It never searches the managed port range. A changed
instance or rejected token invalidates the saved link and requires a new
explicit code.

The IDE client does not send `linkRequest`. Its trusted, role-bound token is
created inside the VS Code extension for the current in-memory bridge instance,
then it uses the same `hello` and `authenticated` exchange.

Unauthenticated connections have ten seconds to complete the handshake.
Malformed messages, repeated link requests, and invalid handshake order close
the connection.

## Unlink

An authenticated client can explicitly remove its current link:

```json
{
  "protocolVersion": 3,
  "type": "unlink",
  "messageId": "unlink-1",
  "sessionId": "default",
  "metadata": {}
}
```

The bridge removes that connection, revokes its token, and closes the socket.
The browser also removes its saved endpoint, session, instance, and token.
Stopping the bridge revokes every token for that instance.

## Link Failures

The protocol uses generic link and authentication errors:

- `link.invalidCode`: the user-facing code is malformed;
- `link.unreachable`: the encoded localhost endpoint cannot be reached;
- `link.rejected`: the bridge rejected a link request without disclosing
  whether the PIN was wrong;
- `link.rateLimited`: link requests are temporarily blocked;
- `auth.tokenRejected`: the token, role, session, or expiry is invalid;
- `auth.instanceChanged`: credentials belong to another bridge start.

Five failed PIN attempts within the rolling failure window trigger one
bridge-wide 60-second cooldown. Parallel sockets share that limit. A correct
PIN also receives `link.rateLimited` while the cooldown is active.

## Inspect Targets

An `inspect` message contains a `targets` array:

- exactly one `selected` target at `depth: 0` is required;
- at most one `parent` target at `depth: 1` is allowed;
- the parent is the selected element's immediate DOM parent only;
- duplicate roles, other depths, more than two targets, or a missing selected
  target are invalid.

Each target owns its `subject`, runtime `facts`, and `metadata`. This keeps
selected-element and parent-element evidence separate all the way to editor
presentation.

```json
{
  "protocolVersion": 3,
  "type": "inspect",
  "messageId": "inspect-42",
  "sessionId": "default",
  "source": {
    "role": "browser",
    "id": "firefox-devtools",
    "metadata": {}
  },
  "targets": [
    {
      "role": "selected",
      "depth": 0,
      "subject": {
        "selector": ".card.featured",
        "metadata": {}
      },
      "facts": [
        {
          "type": "css-rule",
          "selector": ".card",
          "property": "display",
          "value": "grid",
          "metadata": {
            "sourceUrl": "http://127.0.0.1:4173/app.css"
          }
        }
      ],
      "metadata": {}
    },
    {
      "role": "parent",
      "depth": 1,
      "subject": {
        "selector": ".layout",
        "metadata": {}
      },
      "facts": [],
      "metadata": {}
    }
  ],
  "context": {
    "url": "http://127.0.0.1:4173/",
    "metadata": {}
  },
  "metadata": {}
}
```

## Runtime Facts

Known facts such as `css-rule` and `dom-attribute` use closed, strict schemas.
Future adapters and development instrumentation can send plugin facts with:

- a namespaced lowercase `type` containing at least one dot, such as
  `react.component` or `wordpress.acf-block`;
- an optional one-based `source` location;
- a JSON-only `payload`;
- JSON-only `metadata`.

Names must match the protocol namespace grammar; arbitrary single words and
non-JSON values are rejected. Producers should send source identity rather
than DOM text or framework state.

## Source Positions

Wire `SourceLocation` values use one-based line and column numbers. If a source
end is present, both `endLine` and `endColumn` are required and cannot precede
the start.

The public source-plugin API uses a different editor-native representation:
`SourceRange` is zero-based and end-exclusive. Conversion happens at the
browser/IDE boundary and should not leak into browser adapters.

## Document-First Resolution

The IDE retains the newest selection but resolves only against the active text
document:

1. active `languageId` and URI scheme select candidate source plugins;
2. target fact kinds filter candidates again;
3. each plugin returns ranges in the active document only;
4. core validates, deduplicates, and presents selected and parent matches;
5. changing editor or editing the active document re-runs resolution against
   the retained selection.

An inspect message never opens source files. Plugins return semantic source
matches, not tabs, selections, decorations, or colors. This document-first
model lets CSS, SCSS, component, script, and template plugins share the same
protocol without making VS Code depend on a browser implementation.

## Confidence

Resolved source matches use one confidence value:

- `exact`: direct evidence identifies the range;
- `sourcemap`: a generated position maps through a source map;
- `instrumented`: development instrumentation provides a source hint;
- `heuristic`: a best-effort selector, attribute, or text match;
- `unknown`: reliability is not classified.

## Message Families

Protocol version 3 includes:

- link and authenticated-handshake messages bound to one bridge instance;
- inspect messages with selected and optional immediate-parent targets;
- reference messages for source references sent back to a browser when needed;
- command schemas such as source navigation or browser highlighting;
- structured errors for link, authentication, routing, browser, and resolver
  failures;
- ping and pong messages for WebSocket health.

All product traffic remains on WebSocket. Unsupported messages and invalid
target or fact shapes are rejected at the protocol boundary.
