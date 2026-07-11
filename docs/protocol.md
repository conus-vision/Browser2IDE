# Browser2IDE Protocol

The Browser2IDE protocol carries runtime inspection evidence from browser
adapters to IDE presenters through the local WebSocket bridge. Browser adapters
collect facts; IDE source plugins resolve those facts because only the IDE has
workspace access.

## Version

Every message uses `protocolVersion: 2`. Implementations reject unsupported
versions instead of guessing or normalizing legacy shapes. Protocol v1 inspect
messages with top-level `subject` and `facts` are not supported.

## Inspect Targets

An `inspect` message contains a `targets` array instead of one top-level
subject:

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
  "protocolVersion": 2,
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
            "stylesheetUrl": "http://127.0.0.1:4173/app.css"
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
non-JSON values are rejected. The bridge message-size limit applies to the full
message, so producers should send source identity rather than DOM text or
framework state.

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

Protocol version 2 includes:

- Handshake messages that identify role, session, token, and capabilities.
- Pairing messages that exchange a short-lived code for a session token.
- Inspect messages that carry selected and optional immediate-parent targets.
- Reference messages for source references sent back to a browser when needed.
- Command messages such as source navigation or browser highlighting.
- Structured errors for protocol, authentication, routing, browser, and
  resolver failures.
- Ping and pong messages for WebSocket health.

Pairing is part of the WebSocket protocol, not an HTTP or out-of-band product
API. Unsupported messages and invalid target/fact shapes are rejected at the
protocol boundary.
