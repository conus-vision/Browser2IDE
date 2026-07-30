# Architecture

Browser2IDE is a local, read-only bridge from browser DevTools inspection to
source highlighting in VS Code. Protocol v3 carries bounded facts; it does not
carry edit or reverse-sync commands.

## Components

### Browser DevTools Adapters

Firefox and Chrome/Chromium expose a Browser2IDE DevTools panel. A panel owns
the explicit Inspect toggle for its tab and collects bounded page, DOM, and CSS
facts only while inspection is active. Built-in CSS facts carry a stylesheet
`sourceUrl`, selector, property/value declaration, optional media conditions,
and CSSOM `rulePath`. The browser does not read or send `sourceMappingURL`
directives, source-map references, source maps, or generated CSS positions.
Browser adapters collect facts but do not resolve workspace files.

### Browser-Window Coordinator

The background coordinator owns links at browser-window scope. An explicitly
linked window stores one session mapping. All active Browser2IDE panels in tabs
of that window multiplex through at most one authenticated WebSocket; a panel
registers and unregisters its tab with the coordinator. When the final panel
closes, the socket closes but the session mapping can be reused when a panel is
opened again. Other browser windows remain separate and unlinked.

### Protocol

Protocol v3 defines versioned hello, link, authenticated, unlink, inspection,
and health messages. Messages use bounded schemas and carry selected-element
and immediate-parent facts unchanged through the bridge. The complete message
contract is in [protocol.md](protocol.md).

### Local Bridge

Each local VS Code window starts one bridge automatically and binds it to
`127.0.0.1` on a managed port. The bridge creates a seven-digit code from its
port and short PIN, authenticates the explicit link request, and routes messages
between the linked browser window and that VS Code extension runtime. It does
not scan for browsers, IDEs, or network peers.

### VS Code Presenter

The presenter retains the latest valid browser selection and asks plugins to
resolve it against the document currently active in VS Code. It renders
selected-element and immediate-parent decorations and applicable-source
results. It does not open, close, or switch documents, and it exposes no edit
or reverse-sync operation.

### Source-Plugin API

The versioned source-plugin API lets built-in and separately installed VS Code
extensions register resolvers by active document language and URI. The built-in
CSS plugin resolves CSS facts directly. The SCSS plugin uses the stylesheet
`sourceUrl` to discover and read generated CSS in the workspace, matches a
generated rule to obtain its local CSS position, discovers `sourceMappingURL`
from that local file, and then reads and applies the inline or external source
map locally. Plugins return semantic source ranges while the core presenter owns
UI and decoration behavior. API details and examples are in the [source plugin
authoring guide](source-plugin-authoring.md).

## Data Flow

1. VS Code starts its local bridge and displays a seven-digit link code.
2. The user copies the code and explicitly submits it in one browser window.
3. The coordinator opens and authenticates the window's loopback WebSocket.
4. The user explicitly enables Inspect in a DevTools panel and selects an
   element.
5. The browser sends bounded facts for the element and its immediate parent.
6. The bridge validates and forwards the protocol v3 inspection message.
7. The presenter dispatches the latest selection to source plugins compatible
   with the active VS Code document and renders their ranges.

There is no automatic discovery. Browser2IDE does not enumerate VS Code
windows, probe localhost ports, infer a target IDE, or link a new browser
window from another window's mapping.

## Trust Boundaries

The inspected page is untrusted. Browser content scripts collect a narrow,
bounded fact set and communicate with the privileged extension runtime. The
browser extension is trusted to enforce the panel-open, linked-window, and
explicit-Inspect conditions before injection and collection.

The loopback boundary is authenticated but remains a security boundary. The
bridge accepts only supported extension origins and protocol messages, rate
limits link attempts, bounds message size, and revokes credentials when the
bridge stops or the user unlinks. Loopback binding prevents network peers from
connecting directly, but it does not make every local process trusted.

The VS Code extension and installed source plugins can read local workspace
documents. Source plugins are separately installed trusted code. The plugin API
gives each dispatched plugin the full validated selection snapshot, including
all selected/parent targets, subjects, facts, page context, and metadata; the
active document and its full text; and workspace discovery/read services. Those
services allow a plugin to find files, read text from workspace URIs, resolve
source and relative URIs, and check workspace membership. Plugins also receive
a cancellation signal. Browser2IDE has no analytics or remote service.

URLs and permitted DOM attribute values are bounded but not content-redacted
and may contain sensitive application data. The detailed permission, origin,
credential, and data-handling rules are documented in [security.md](security.md).

## Contracts

- [Protocol v3](protocol.md)
- [Security model](security.md)
- [Source plugin authoring](source-plugin-authoring.md)
