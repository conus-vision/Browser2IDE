# Browser2IDE Protocol

The Browser2IDE protocol carries runtime inspection facts from browser adapters to IDE presenters through the local bridge. Its purpose is to keep browser-specific collection, bridge routing, and IDE source resolution separate while preserving a shared contract for future resolvers.

## Universal Shape

Protocol messages use a universal `subject -> facts -> references` model.

- `subject` describes the thing selected at runtime, such as a DOM node.
- `facts` describe observable runtime information about that subject, such as matched CSS rules, attributes, and stylesheet metadata.
- `references` describe source locations resolved by the IDE from those facts, such as SCSS rules, generated CSS rules, templates, components, or scripts.

The browser sends runtime facts. The IDE resolves source references because it has workspace access.

## Version

MVP messages use `protocolVersion: 1`. Implementations must reject unsupported protocol versions instead of guessing.

## Positions

All protocol source locations use 1-based line and column numbers. Conversion to editor APIs that use 0-based positions happens only inside IDE presenter code.

## Confidence

Source references include a confidence level:

- `exact`: The runtime fact maps directly to an exact source range.
- `sourcemap`: The reference was mapped through a source map, usually from generated CSS to SCSS.
- `instrumented`: The reference came from explicit runtime or build-time instrumentation.
- `heuristic`: The reference is a best-effort match, such as selector search in generated CSS.
- `unknown`: The resolver cannot describe how reliable the reference is.

## Core Message Families

Protocol version 1 includes these message families:

- Handshake: clients identify their role and session before normal routing.
- Pairing: Firefox submits a short-lived pairing code and receives a session token when accepted.
- Inspect: browser or simulator clients send a selected subject plus runtime facts.
- References: IDE clients send resolved source references back to browser clients when needed.
- Commands: IDE clients can send commands to browser clients in the same session.
- Errors: clients and the bridge report structured protocol, auth, routing, and resolver failures.
- Heartbeat: ping and pong messages keep WebSocket sessions healthy.

Pairing is part of the protocol rather than an out-of-band setup step. Pair requests include the pairing code and client source. Pair accepted messages include the session ID, random auth token, and token expiry.
