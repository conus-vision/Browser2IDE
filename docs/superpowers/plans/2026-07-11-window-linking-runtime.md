# Browser2IDE Window Linking Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace persistent six-digit pairing with a protocol-v3 bridge instance, five-digit port plus two-digit PIN link code, in-memory credentials, automatic VS Code lifecycle, and clickable status-bar controls while preserving a working Firefox development flow.

**Architecture:** Every VS Code window creates one `LinkAuthenticator` and tries ports `48735..48834` until its managed WebSocket bridge starts. Protocol v3 binds hello credentials to a random bridge instance ID, rate-limits two-digit PIN attempts, acknowledges authentication, and revokes all credentials at stop. VS Code renders link-copy and start/stop status items; the existing Firefox panel is migrated to the new protocol as an intermediate single-panel client before browser-window ownership moves to the shared background runtime in Plan 2.

**Tech Stack:** Node.js 22, pnpm 9, TypeScript 5.9, Zod 3, Vitest 2, ws 8, VS Code Extension API, Firefox WebExtensions.

---

## Execution Preconditions

- Read `docs/superpowers/specs/2026-07-11-zero-terminal-window-linking-design.md`.
- Start from commit `b145fae` or a descendant containing only reviewed work.
- Preserve the unrelated untracked file `docs/superpowers/plans/2026-07-09-browser2ide-mvp.md`.
- Use a dedicated feature branch or worktree named `feat/window-linking-runtime`.
- Do not retain compatibility with protocol v2 or persisted six-digit pairing.

## Planned File Structure

New bridge authentication unit:

```text
packages/bridge/src/linkAuthenticator.ts
packages/bridge/test/linkAuthenticator.test.ts
```

New VS Code lifecycle UI units:

```text
extensions/vscode/src/statusBarController.ts
extensions/vscode/test/statusBarController.test.ts
```

Removed legacy pairing units after migration:

```text
packages/bridge/src/pairing.ts
packages/bridge/test/pairing.test.ts
extensions/vscode/src/pairing.ts
extensions/vscode/test/pairing.test.ts
extensions/vscode/test/pairingCodeCommand.test.ts
```

### Task 1: Define Protocol V3 Linking And Authentication

**Files:**
- Modify: `packages/protocol/src/capabilities.ts`
- Modify: `packages/protocol/src/messages.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/src/schema.ts`
- Modify: `packages/protocol/test/schema.test.ts`
- Modify: `packages/protocol/test/public-export.mjs`

- [ ] **Step 1: Write failing protocol-v3 tests**

Add focused cases to `packages/protocol/test/schema.test.ts` using the existing
message helpers:

```ts
it("accepts a two-digit browser link request", () => {
  const message = {
    ...baseMessage("linkRequest"),
    pin: "07",
    source: browserSource,
  };

  expect(parseMessage(message)).toEqual(message);
});

it("accepts link, authenticated, and unlink responses", () => {
  expect(parseMessage({
    ...baseMessage("linkAccepted"),
    sessionId: "default",
    bridgeInstanceId: "2d7856f5-8218-4ba6-9f6c-7aa459333ee1",
    authToken: "a".repeat(64),
    expiresAt: "2026-07-12T00:00:00.000Z",
  }).type).toBe("linkAccepted");

  expect(parseMessage({
    ...baseMessage("authenticated"),
    sessionId: "default",
    bridgeInstanceId: "2d7856f5-8218-4ba6-9f6c-7aa459333ee1",
  }).type).toBe("authenticated");

  expect(parseMessage({
    ...baseMessage("unlink"),
    sessionId: "default",
  }).type).toBe("unlink");
});

it.each(["7", "007", "aa"])("rejects invalid PIN %s", (pin) => {
  expect(() => parseMessage({
    ...baseMessage("linkRequest"),
    pin,
    source: browserSource,
  })).toThrow();
});

it("requires the expected bridge instance in hello", () => {
  expect(() => parseMessage({
    ...helloMessage,
    bridgeInstanceId: undefined,
  })).toThrow();
});

it("rejects protocol v2", () => {
  expect(() => parseMessage({
    ...baseMessage("ping"),
    protocolVersion: 2,
    sentAt: "2026-07-11T00:00:00.000Z",
  })).toThrow();
});
```

Change the local `baseMessage` helper to emit `protocolVersion: 3`. Add error
cases for `link.rejected`, `link.rateLimited`, `auth.tokenRejected`,
`auth.instanceChanged`, and `bridge.offline`.

- [ ] **Step 2: Run the protocol suite and verify RED**

```powershell
corepack pnpm --filter @browser2ide/protocol test
```

Expected: FAIL because protocol v2 has no link or authenticated messages.

- [ ] **Step 3: Implement the protocol-v3 schemas**

In `messages.ts`, set:

```ts
export const PROTOCOL_VERSION = 3 as const;

export const BridgeInstanceIdSchema = z.string().uuid();

export const LinkRequestMessageSchema = baseMessageSchema.extend({
  type: z.literal("linkRequest"),
  pin: z.string().regex(/^\d{2}$/),
  source: ClientSourceSchema.refine(
    (source) => source.role === "browser" || source.role === "simulator",
    "link requests require a browser or simulator source",
  ),
}).strict();

export const LinkAcceptedMessageSchema = baseMessageSchema.extend({
  type: z.literal("linkAccepted"),
  sessionId: z.string().min(1),
  bridgeInstanceId: BridgeInstanceIdSchema,
  authToken: z.string().min(32),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

export const AuthenticatedMessageSchema = baseMessageSchema.extend({
  type: z.literal("authenticated"),
  sessionId: z.string().min(1),
  bridgeInstanceId: BridgeInstanceIdSchema,
}).strict();

export const UnlinkMessageSchema = baseMessageSchema.extend({
  type: z.literal("unlink"),
  sessionId: z.string().min(1),
}).strict();
```

Add `bridgeInstanceId: BridgeInstanceIdSchema` to `HelloMessageSchema`. Add the
four new schemas to `Browser2IdeMessageSchema` and export their types. Keep the
legacy pair schemas temporarily so existing clients compile during Tasks 1-3;
Task 4 removes them immediately after every client migrates.

Replace pairing error codes with:

```ts
export const ProtocolErrorCodeSchema = z.enum([
  "link.invalidCode",
  "link.unreachable",
  "link.rejected",
  "link.rateLimited",
  "auth.tokenRejected",
  "auth.instanceChanged",
  "protocol.invalidMessage",
  "bridge.noIdeClient",
  "bridge.noBrowserClient",
  "bridge.offline",
  "resolver.fileNotFound",
  "resolver.sourceMapFailed",
  "browser.stylesheetInaccessible",
]);
```

Keep legacy pairing errors in the enum only until Task 4 so the old bridge
implementation compiles during the migration.

In `capabilities.ts`, replace `Pairing: "pairing"` with `Link: "link"` and
include it in `ProtocolCapabilitySchema`.

- [ ] **Step 4: Update public exports**

Export `BridgeInstanceIdSchema`, `LinkRequestMessage`, `LinkAcceptedMessage`,
`AuthenticatedMessage`, and `UnlinkMessage` through `schema.ts` and `index.ts`.
Change `test/public-export.mjs` to assert `PROTOCOL_VERSION === 3` and that each
new schema export exists.

- [ ] **Step 5: Run protocol GREEN**

```powershell
corepack pnpm --filter @browser2ide/protocol test
corepack pnpm --filter @browser2ide/protocol typecheck
```

Expected: all protocol tests and the public export check pass.

- [ ] **Step 6: Commit the wire contract**

```powershell
git add packages/protocol
git commit -m "feat(protocol)!: add window link handshake"
```

Commit body:

```text
BREAKING CHANGE: protocol v2 pairing messages and six-digit codes are
replaced by protocol v3 link, authenticated, and unlink messages.
```

### Task 2: Add LinkAuthenticator Beside Legacy Pairing

**Files:**
- Create: `packages/bridge/src/linkAuthenticator.ts`
- Create: `packages/bridge/test/linkAuthenticator.test.ts`
- Modify: `packages/bridge/src/auth.ts`
- Modify: `packages/bridge/test/auth.test.ts`
- Modify: `packages/bridge/src/index.ts`

- [ ] **Step 1: Write failing authenticator tests**

Create `linkAuthenticator.test.ts` with deterministic injected values:

```ts
describe("LinkAuthenticator", () => {
  it("keeps a two-digit PIN and instance identity for its lifetime", () => {
    const auth = authenticator();
    expect(auth.linkInfo()).toEqual({
      bridgeInstanceId: INSTANCE_ID,
      pin: "07",
    });
  });

  it("issues a role-bound token for a matching PIN", () => {
    const auth = authenticator();
    const result = auth.attemptLink("07", "browser");
    expect(result).toMatchObject({
      accepted: {
        sessionId: "default",
        bridgeInstanceId: INSTANCE_ID,
        authToken: { role: "browser", bridgeInstanceId: INSTANCE_ID },
      },
    });
  });

  it("enters a global cooldown after five failures", () => {
    let now = 0;
    const auth = authenticator({ now: () => new Date(now) });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(auth.attemptLink("99", "browser")).toEqual({
        errorCode: "link.rejected",
      });
    }
    expect(auth.attemptLink("99", "browser")).toMatchObject({
      errorCode: "link.rateLimited",
      retryAt: new Date(60_000),
    });
    expect(auth.attemptLink("07", "browser")).toMatchObject({
      errorCode: "link.rateLimited",
    });
    now = 60_001;
    expect(auth.attemptLink("07", "browser")).toHaveProperty("accepted");
  });

  it("rejects another instance and revokes one token", () => {
    const auth = authenticator();
    const accepted = acceptedToken(auth);
    expect(auth.validateToken("default", "browser", accepted.value, INSTANCE_ID))
      .toBe("accepted");
    expect(auth.validateToken("default", "browser", accepted.value, OTHER_ID))
      .toBe("instanceChanged");
    auth.revokeToken(accepted.value);
    expect(auth.validateToken("default", "browser", accepted.value, INSTANCE_ID))
      .toBe("rejected");
  });
});
```

Use constants `INSTANCE_ID`, `OTHER_ID`, and a local helper that constructs
`LinkAuthenticator` with `pin: "07"`, `sessionId: "default"`, and deterministic
`now`.

- [ ] **Step 2: Run bridge tests and verify RED**

```powershell
corepack pnpm --filter @browser2ide/bridge test -- linkAuthenticator.test.ts
```

Expected: FAIL because `LinkAuthenticator` does not exist.

- [ ] **Step 3: Bind authorized tokens to a bridge instance**

Change `AuthorizedToken` and `createAuthorizedToken` in `auth.ts`:

```ts
export interface AuthorizedToken {
  readonly sessionId: string;
  readonly role: ClientRole;
  readonly bridgeInstanceId: string;
  readonly value: string;
  readonly expiresAt: Date;
}

export function createAuthorizedToken(
  sessionId: string,
  role: ClientRole,
  bridgeInstanceId: string,
  now = new Date(),
): AuthorizedToken {
  return {
    sessionId,
    role,
    bridgeInstanceId,
    value: randomBytes(32).toString("hex"),
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
  };
}
```

Update `auth.test.ts` to pass the instance ID and assert it is retained.

- [ ] **Step 4: Implement LinkAuthenticator**

Create a focused class with this public contract:

```ts
export type TokenValidation = "accepted" | "rejected" | "instanceChanged";

export interface LinkAuthenticatorOptions {
  readonly sessionId: string;
  readonly bridgeInstanceId?: string;
  readonly pin?: string;
  readonly now?: () => Date;
  readonly randomInstanceId?: () => string;
  readonly randomPin?: () => string;
}

export class LinkAuthenticator {
  linkInfo(): { readonly bridgeInstanceId: string; readonly pin: string };
  issueTrustedToken(role: "ide"): AuthorizedToken;
  attemptLink(pin: string, role: "browser" | "simulator"): LinkAttempt;
  validateToken(
    sessionId: string,
    role: ClientRole,
    token: string,
    bridgeInstanceId: string,
  ): TokenValidation;
  revokeToken(token: string): void;
  revokeRole(role: ClientRole): void;
  revokeAll(): void;
}
```

Use `randomUUID()` and `randomInt(0, 100).toString().padStart(2, "0")` by
default. Store tokens only in a private in-memory array. Compare PINs and tokens
with `tokensEqual`. Prune failures older than 60 seconds before every attempt;
on the fifth failure set `cooldownUntil` to `now + 60_000` and clear the rolling
failure list after cooldown.

- [ ] **Step 5: Replace bridge exports and delete legacy pairing**

Export `LinkAuthenticator`, `LinkAttempt`, `LinkAuthenticatorOptions`, and
`TokenValidation` from `src/index.ts`. Keep `PairingStore` temporarily because
the old VS Code manager still imports it; Task 5 removes the store and exports
after manager migration.

- [ ] **Step 6: Run bridge authentication GREEN**

```powershell
corepack pnpm --filter @browser2ide/bridge test -- auth.test.ts linkAuthenticator.test.ts
corepack pnpm --filter @browser2ide/bridge typecheck
```

Expected: auth and link authenticator tests pass.

- [ ] **Step 7: Commit in-memory link authentication**

```powershell
git add packages/bridge
git commit -m "feat(bridge): add instance link auth"
```

### Task 3: Enforce The V3 Handshake In The WebSocket Server

**Files:**
- Modify: `packages/bridge/src/server.ts`
- Modify: `packages/bridge/src/clientRegistry.ts`
- Modify: `packages/bridge/src/router.ts`
- Modify: `packages/bridge/test/server.test.ts`
- Modify: `packages/bridge/test/router.test.ts`
- Modify: `packages/bridge/test/heartbeat.test.ts`

- [ ] **Step 1: Write failing server handshake tests**

Add server cases that use port `0` and a deterministic authenticator:

```ts
it("links, authenticates, acknowledges, and unlinks a browser", async () => {
  const harness = await bridgeHarness({ pin: "07", instanceId: INSTANCE_ID });
  const socket = await harness.connect();

  socket.send(JSON.stringify(linkRequest("07")));
  const linked = await harness.nextMessage(socket);
  expect(linked).toMatchObject({
    type: "linkAccepted",
    bridgeInstanceId: INSTANCE_ID,
  });

  socket.send(JSON.stringify(hello({
    token: linked.authToken,
    bridgeInstanceId: INSTANCE_ID,
  })));
  expect(await harness.nextMessage(socket)).toMatchObject({
    type: "authenticated",
    bridgeInstanceId: INSTANCE_ID,
  });

  socket.send(JSON.stringify(unlinkMessage()));
  await harness.closed(socket);
  expect(harness.authenticator.validateToken(
    "default", "browser", linked.authToken, INSTANCE_ID,
  )).toBe("rejected");
});

it("returns one generic error for a wrong PIN", async () => {
  const harness = await bridgeHarness({ pin: "07", instanceId: INSTANCE_ID });
  const socket = await harness.connect();
  socket.send(JSON.stringify(linkRequest("99")));
  expect(await harness.nextMessage(socket)).toMatchObject({
    type: "error",
    code: "link.rejected",
    message: "Link request rejected",
  });
});

it("rejects a token from a previous bridge instance", async () => {
  const harness = await bridgeHarness({ pin: "07", instanceId: OTHER_ID });
  const socket = await harness.connect();
  socket.send(JSON.stringify(hello({
    token: TOKEN_FROM_OLD_INSTANCE,
    bridgeInstanceId: INSTANCE_ID,
  })));
  expect(await harness.nextMessage(socket)).toMatchObject({
    code: "auth.instanceChanged",
  });
});
```

Add one test proving `onClientCountChanged` emits browser counts `1` then `0`.

- [ ] **Step 2: Run server tests and verify RED**

```powershell
corepack pnpm --filter @browser2ide/bridge test -- server.test.ts
```

Expected: FAIL because the server still handles `pairRequest` and never sends
an authentication acknowledgement.

- [ ] **Step 3: Change the server contract**

Use this public shape in `server.ts`:

```ts
export interface BridgeServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly sessionId?: string;
  readonly authenticator?: LinkAuthenticator;
  readonly registry?: ClientRegistry;
}

export interface BridgeServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  getUrl(): string;
  getLinkInfo(): { readonly bridgeInstanceId: string; readonly pin: string };
  onClientCountChanged(
    listener: (counts: { readonly browser: number; readonly ide: number }) => void,
  ): { dispose(): void };
  readonly registry: ClientRegistry;
  readonly authenticator: LinkAuthenticator;
}
```

The default authenticator uses the configured default session. `stop()` must
close sockets, stop heartbeat, clear the registry, revoke all authenticator
tokens, and notify counts `{ browser: 0, ide: 0 }`.

- [ ] **Step 4: Implement unauthenticated link and authenticated hello**

In `handleConnection`:

1. Permit `linkRequest` before registration and call `attemptLink`.
2. Send `linkAccepted` with instance ID, token, session, and expiry.
3. Require hello for every other unregistered message.
4. Compare hello's expected instance before validating its role-bound token.
5. Register the client with its auth token and send `authenticated`.
6. Handle authenticated `unlink` by revoking only that token and closing the
   socket.
7. Keep `pong` and routed messages unchanged after registration.

Store `authToken` on `RegisteredClient` so unlink can revoke the exact token.
Add `countByRole(role)` and `clear()` to `ClientRegistry`. Notify count
listeners after add, close, and clear.

- [ ] **Step 5: Update router and heartbeat fixtures to protocol v3**

Replace protocol literals and hello fixtures with `PROTOCOL_VERSION` and a
valid `bridgeInstanceId`. The router remains role-gated: browser/simulator may
send inspect; only IDE may send references or bounded command messages.

- [ ] **Step 6: Run all bridge tests GREEN**

```powershell
corepack pnpm --filter @browser2ide/bridge test
corepack pnpm --filter @browser2ide/bridge build
```

Expected: every bridge test passes and TypeScript builds.

- [ ] **Step 7: Commit the server handshake**

```powershell
git add packages/bridge
git commit -m "feat(bridge): enforce link handshake"
```

### Task 4: Migrate IDE, Browser, And Simulator Clients

**Files:**
- Modify: `extensions/vscode/src/bridgeClient.ts`
- Modify: `extensions/vscode/test/bridgeClient.test.ts`
- Modify: `extensions/firefox/src/bridgeClient.ts`
- Modify: `extensions/firefox/test/pairingClient.test.ts`
- Modify: `tools/simulator/src/sendInspect.ts`
- Modify: `tools/simulator/test/sendInspect.test.ts`
- Modify: `packages/protocol/src/messages.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/src/schema.ts`
- Modify: `packages/protocol/test/schema.test.ts`

- [ ] **Step 1: Write failing acknowledgement and instance tests**

Update VS Code client tests so `connected` occurs only after the fake socket
receives:

```ts
{
  protocolVersion: 3,
  type: "authenticated",
  messageId: "authenticated-1",
  sessionId: "default",
  bridgeInstanceId: INSTANCE_ID,
  metadata: {},
}
```

Update Firefox client tests to call `client.link("07")`, expect
`type: "linkRequest"`, then feed `linkAccepted` and `authenticated`. Assert
stored credentials contain `bridgeInstanceId` and reconnect hello sends it.

Update simulator argument tests to accept `--link-code 4873507` and reject
legacy `--pairing-code`.

- [ ] **Step 2: Run the three focused suites and verify RED**

```powershell
corepack pnpm --filter browser2ide-vscode test -- bridgeClient.test.ts
corepack pnpm --filter browser2ide-firefox test -- pairingClient.test.ts
corepack pnpm --filter @browser2ide/simulator test -- sendInspect.test.ts
```

Expected: all three fail on legacy pairing or eager connected state.

- [ ] **Step 3: Migrate VS Code BridgeClient**

Extend its options with `bridgeInstanceId`. Include that field in hello and do
not call `setState("connected")` on socket open. Handle `authenticated` by
checking both session and instance, resetting reconnect attempts, and then
setting connected. Map `auth.instanceChanged` and `auth.tokenRejected` to the
existing protocol-error callback and stop reconnecting until lifecycle restart.

- [ ] **Step 4: Migrate BrowserBridgeClient**

Use these credentials and intent types:

```ts
export interface BrowserCredentials {
  readonly sessionId: string;
  readonly bridgeInstanceId: string;
  readonly authToken: string;
}

type ConnectionIntent =
  | { readonly kind: "link"; readonly pin: string }
  | { readonly kind: "credentials"; readonly credentials: BrowserCredentials };
```

Rename `pair` to `link`. Send `linkRequest`, store the complete
`linkAccepted` credentials, send hello with the instance ID, and set connected
only on matching `authenticated`. Add `unlink()` that sends an authenticated
unlink message before closing. Advertise capability `link`, not `pairing`.

- [ ] **Step 5: Migrate the simulator CLI**

Parse a seven-digit `--link-code`; derive URL and PIN with:

```ts
export function parseLinkCode(value: string) {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d{7}$/.test(digits)) {
    throw new Error("Link code must contain seven digits");
  }
  const port = Number(digits.slice(0, 5));
  if (port < 10_000 || port > 65_535) {
    throw new Error("Link code contains an invalid port");
  }
  return { url: `ws://127.0.0.1:${port}`, pin: digits.slice(5) };
}
```

Wait for both `linkAccepted` and `authenticated` before sending inspect.
Retain explicit token mode for diagnostics, but require session ID and bridge
instance ID together with the token.

After all three clients use link messages, delete the legacy pair schemas,
types, protocol errors, and `pairing` capability from the protocol union. Add a
schema test that protocol-v3 `pairRequest` is rejected.

- [ ] **Step 6: Run client suites GREEN**

```powershell
corepack pnpm --filter browser2ide-vscode test -- bridgeClient.test.ts
corepack pnpm --filter browser2ide-firefox test -- pairingClient.test.ts
corepack pnpm --filter @browser2ide/simulator test -- sendInspect.test.ts
corepack pnpm --filter @browser2ide/protocol test
```

Expected: all focused suites pass.

- [ ] **Step 7: Commit client migration**

```powershell
git add extensions/vscode/src/bridgeClient.ts extensions/vscode/test/bridgeClient.test.ts extensions/firefox/src/bridgeClient.ts extensions/firefox/test/pairingClient.test.ts tools/simulator
git commit -m "feat(clients)!: use bridge link identity"
```

Commit body:

```text
BREAKING CHANGE: clients must use protocol-v3 link codes or credentials bound
to a bridge instance.
```

### Task 5: Make BridgeManager Own One Ephemeral Window Instance

**Files:**
- Rewrite: `extensions/vscode/src/bridgeManager.ts`
- Rewrite: `extensions/vscode/test/bridgeManager.test.ts`
- Modify: `extensions/vscode/src/config.ts`
- Modify: `extensions/vscode/test/diagnostics.test.ts`
- Modify: `extensions/vscode/src/diagnostics.ts`
- Delete: `extensions/vscode/src/pairing.ts`
- Delete: `extensions/vscode/test/pairing.test.ts`
- Delete: `extensions/vscode/test/pairingCodeCommand.test.ts`
- Delete: `packages/bridge/src/pairing.ts`
- Delete: `packages/bridge/test/pairing.test.ts`
- Modify: `packages/bridge/src/index.ts`

- [ ] **Step 1: Write failing lifecycle and port-range tests**

The rewritten manager tests must prove:

```ts
it("tries exactly the fixed managed range", async () => {
  const attempts: number[] = [];
  const manager = managerHarness({
    createBridge: ({ port }) => {
      attempts.push(port);
      if (port < 48_834) throw addressInUse();
      return fakeBridge({ port, pin: "07", instanceId: INSTANCE_ID });
    },
  });
  await manager.start();
  expect(attempts).toEqual(Array.from({ length: 100 }, (_, i) => 48_735 + i));
  expect(manager.snapshot()).toMatchObject({
    state: "running",
    port: 48_834,
    linkCode: "4883407",
    bridgeInstanceId: INSTANCE_ID,
  });
});

it("fails after all 100 ports and can retry", async () => {
  const manager = managerHarness({ createBridge: () => { throw addressInUse(); } });
  await expect(manager.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
  expect(manager.snapshot().state).toBe("error");
  await expect(manager.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
});

it("creates a new instance after stop and start", async () => {
  const manager = managerHarness({ instances: [INSTANCE_ID, OTHER_ID] });
  await manager.start();
  const first = manager.snapshot();
  await manager.stop();
  await manager.start();
  expect(manager.snapshot().bridgeInstanceId).not.toBe(first.bridgeInstanceId);
});
```

Retain serialized concurrent start/stop coverage and add a state-listener test
for linked browser counts.

- [ ] **Step 2: Run manager tests and verify RED**

```powershell
corepack pnpm --filter browser2ide-vscode test -- bridgeManager.test.ts
```

Expected: FAIL because manager persists browser tokens and refreshes legacy
pairing codes.

- [ ] **Step 3: Rewrite BridgeManager without SecretStorage**

Use fixed constants:

```ts
export const MANAGED_PORT_START = 48_735;
export const MANAGED_PORT_COUNT = 100;
```

`start()` creates one `LinkAuthenticator`, issues one trusted IDE token, and
passes the same authenticator to each port attempt. A successful snapshot is:

```ts
export interface BridgeSnapshot {
  readonly state: BridgeManagerState;
  readonly url?: string;
  readonly port?: number;
  readonly pin?: string;
  readonly linkCode?: string;
  readonly bridgeInstanceId?: string;
  readonly sessionId: string;
  readonly linkedBrowserCount: number;
}
```

Expose `getIdeCredentials()` returning session, token, and instance ID. Add
`onStateChanged(listener)` and notify after every transition and browser-count
event. `stop()` disposes server listeners, stops the server, clears credentials
and link code, and ends in stopped even when called twice.

- [ ] **Step 4: Remove pairing persistence and obsolete configuration**

Delete the VS Code pairing source and tests. Remove `bridgeUrl` and
`bridgePort` from `BridgeConfiguration`; retain only `sessionId`. Remove the two
configuration contributions from `extensions/vscode/package.json` in Task 7.
Remove the now-unused bridge `PairingStore` source, test, and public exports.

Update diagnostics snapshots to include `port`, `bridgeInstanceId`, and
`linkedBrowserCount` but exclude `pin` and `linkCode`.

- [ ] **Step 5: Run manager and diagnostics GREEN**

```powershell
corepack pnpm --filter browser2ide-vscode test -- bridgeManager.test.ts diagnostics.test.ts
corepack pnpm --filter browser2ide-vscode typecheck
```

Expected: manager and sanitized diagnostics pass.

- [ ] **Step 6: Commit the ephemeral manager**

```powershell
git add extensions/vscode
git commit -m "refactor(vscode)!: use ephemeral bridge links"
```

Commit body:

```text
BREAKING CHANGE: bridge URL, port settings, persisted browser tokens, and
six-digit pairing commands are removed.
```

### Task 6: Add Copy And Start/Stop Status-Bar Controls

**Files:**
- Create: `extensions/vscode/src/statusBarController.ts`
- Create: `extensions/vscode/test/statusBarController.test.ts`

- [ ] **Step 1: Write failing status-bar controller tests**

Create fake status items and assert exact rendering:

```ts
it("shows a copyable grouped code and stop action while running", () => {
  const host = statusHost();
  const controller = new StatusBarController(host);
  controller.render({
    state: "running",
    port: 48_735,
    pin: "07",
    linkCode: "4873507",
    bridgeInstanceId: INSTANCE_ID,
    sessionId: "default",
    linkedBrowserCount: 2,
  });

  expect(host.primary).toMatchObject({
    text: "$(radio-tower) Browser2IDE: 48735 07",
    command: "browser2ide.copyLinkCode",
  });
  expect(host.toggle).toMatchObject({
    text: "$(debug-stop)",
    command: "browser2ide.stop",
  });
  expect(host.primary.tooltip).toContain("Linked browser windows: 2");
});

it.each([
  ["stopped", "$(play)", "browser2ide.start"],
  ["starting", "$(sync~spin)", undefined],
  ["stopping", "$(sync~spin)", undefined],
  ["error", "$(play)", "browser2ide.start"],
] as const)("renders %s", (state, icon, command) => {
  const host = statusHost();
  new StatusBarController(host).render(emptySnapshot(state));
  expect(host.toggle.text).toBe(icon);
  expect(host.toggle.command).toBe(command);
});
```

Add disposal and no-token-in-tooltip assertions.

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
corepack pnpm --filter browser2ide-vscode test -- statusBarController.test.ts
```

Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Implement StatusBarController**

Define narrow `StatusBarItemLike` and `StatusBarHost` interfaces so tests do not
import `vscode`. The controller receives two already-created items, calls
`show()` once, renders stable text and commands from `BridgeSnapshot`, and
disposes both. Format only a validated five-digit port and two-digit PIN:

```ts
export function formatVisibleLinkCode(port: number, pin: string): string {
  if (port < 10_000 || port > 65_535 || !/^\d{2}$/.test(pin)) {
    throw new Error("Cannot display an invalid Browser2IDE link code");
  }
  return `${port} ${pin}`;
}
```

The primary item uses a stable alignment/priority supplied by the extension.
When stopped or errored it reads `$(radio-tower) Browser2IDE: Offline`; during
transitions it reads `Browser2IDE: Starting` or `Stopping`.

- [ ] **Step 4: Run status tests GREEN**

```powershell
corepack pnpm --filter browser2ide-vscode test -- statusBarController.test.ts
```

Expected: all status rendering tests pass.

- [ ] **Step 5: Commit status controls**

```powershell
git add extensions/vscode/src/statusBarController.ts extensions/vscode/test/statusBarController.test.ts
git commit -m "feat(vscode): add bridge status controls"
```

### Task 7: Wire Automatic VS Code Startup And Commands

**Files:**
- Modify: `extensions/vscode/src/extension.ts`
- Modify: `extensions/vscode/package.json`
- Modify: `extensions/vscode/test/manifest.test.ts`
- Modify: `extensions/vscode/test/commands.test.ts`

- [ ] **Step 1: Write failing manifest and command tests**

Assert the manifest contains:

```ts
expect(manifest.activationEvents).toContain("onStartupFinished");
expect(manifest.extensionKind).toEqual(["ui"]);
expect(commandIds).toEqual(expect.arrayContaining([
  "browser2ide.start",
  "browser2ide.stop",
  "browser2ide.copyLinkCode",
]));
expect(commandIds).not.toContain("browser2ide.showPairingCode");
expect(commandIds).not.toContain("browser2ide.resetPairing");
expect(manifest.contributes.configuration.properties)
  .not.toHaveProperty("browser2ide.bridgePort");
```

Add a command-host unit proving copy writes the exact ungrouped link code and
shows `Browser2IDE link code copied.`.

- [ ] **Step 2: Run tests and verify RED**

```powershell
corepack pnpm --filter browser2ide-vscode test -- manifest.test.ts commands.test.ts
```

Expected: FAIL on legacy pairing commands and non-clickable status bar.

- [ ] **Step 3: Compose manager, client, status, and commands**

In `activate`:

1. Create `BridgeManager({ configuration })` without secret storage.
2. Create two VS Code status bar items with adjacent priorities.
3. Construct `StatusBarController` and subscribe it to manager state.
4. Register `copyLinkCode`; reject when no running link code, otherwise call
   `vscode.env.clipboard.writeText(snapshot.linkCode)` and show the confirmation.
5. Register start and stop through one serialized lifecycle path.
6. After manager starts, create the IDE `BridgeClient` from
   `getIdeCredentials()` and await its normal reconnect behavior.
7. Call start automatically at the end of activation and report errors only to
   the status/output surfaces.
8. Dispose subscriptions and stop the bridge during deactivation.

Do not expose PIN or link code in output-channel diagnostics.

- [ ] **Step 4: Update the extension manifest**

Add `"extensionKind": ["ui"]`, replace pairing commands with
`browser2ide.copyLinkCode`, and remove `browser2ide.bridgeUrl` and
`browser2ide.bridgePort` settings. Retain `browser2ide.sessionId` for protocol
namespacing.

- [ ] **Step 5: Run VS Code package GREEN**

```powershell
corepack pnpm --filter browser2ide-vscode test
corepack pnpm --filter browser2ide-vscode build
```

Expected: every VS Code unit test and build passes.

- [ ] **Step 6: Commit automatic startup wiring**

```powershell
git add extensions/vscode
git commit -m "feat(vscode): start bridge on window startup"
```

### Task 8: Keep Firefox Development Flow Working On Protocol V3

**Files:**
- Modify: `extensions/firefox/src/panelState.ts`
- Modify: `extensions/firefox/src/panel.ts`
- Modify: `extensions/firefox/src/panel.html`
- Modify: `extensions/firefox/src/panel.css`
- Modify: `extensions/firefox/src/panelDiagnostics.ts`
- Modify: `extensions/firefox/test/panelState.test.ts`
- Modify: `extensions/firefox/test/panelAssets.test.ts`
- Modify: `extensions/firefox/test/panelDiagnostics.test.ts`

- [ ] **Step 1: Write failing seven-digit panel tests**

Replace settings tests with credentials containing `bridgeInstanceId`. Add a
pure parser test through an exported intermediate helper:

```ts
expect(parseLinkCode("48735 07")).toEqual({
  code: "4873507",
  url: "ws://127.0.0.1:48735",
  pin: "07",
});
expect(parseLinkCode("48735-07")).toEqual({
  code: "4873507",
  url: "ws://127.0.0.1:48735",
  pin: "07",
});
expect(() => parseLinkCode("487350")).toThrow("seven digits");
```

Panel asset tests must require `link-code`, `link-button`, `unlink-button`, and
manual `inspect-mode`, and reject legacy `bridge-url`, `session-id`, and
`pairing-code` controls.

- [ ] **Step 2: Run Firefox panel tests and verify RED**

```powershell
corepack pnpm --filter browser2ide-firefox test -- panelState.test.ts panelAssets.test.ts panelDiagnostics.test.ts
```

Expected: FAIL because the panel still exposes manual URL/session pairing.

- [ ] **Step 3: Implement the intermediate panel link flow**

Export `parseLinkCode` from `panelState.ts` and store only URL, session,
instance ID, and token after success. Update panel initialization to show
`Not linked`; a link action parses the field, creates `BrowserBridgeClient` for
the derived URL, and calls `link(pin)`. `Unlink` sends unlink, clears the stored
credentials, disables inspect mode, and resets diagnostics.

This intermediate storage remains panel-owned only until Plan 2. Do not add
automatic port scanning or automatic IDE selection.

- [ ] **Step 4: Replace the connection UI**

Use one seven-digit text input with `inputmode="numeric"`, `maxlength="9"`
(allowing visual separators), a `Link` command, an `Unlink` command, connection
status, and the existing manual inspect toggle. Keep the compact operational
panel layout; do not add onboarding or marketing copy.

- [ ] **Step 5: Run Firefox GREEN**

```powershell
corepack pnpm --filter browser2ide-firefox test
corepack pnpm --filter browser2ide-firefox build
corepack pnpm dlx web-ext@10.4.0 lint --source-dir extensions/firefox --ignore-files package.json pnpm-lock.yaml tsconfig.json esbuild.mjs "src/**" "test/**"
```

Expected: Firefox tests and build pass; web-ext reports zero errors, warnings,
and notices.

- [ ] **Step 6: Commit the Firefox compatibility slice**

```powershell
git add extensions/firefox
git commit -m "feat(firefox): link with bridge code"
```

### Task 9: Update Runtime Documentation And Run The Gate

**Files:**
- Modify: `docs/protocol.md`
- Modify: `docs/security.md`
- Modify: `docs/mvp-usage.md`
- Modify: `docs/mvp-verification.md`

- [ ] **Step 1: Document protocol v3 and the security boundary**

Describe link request, link accepted, authenticated hello, unlink, instance
identity, role-bound tokens, the five-attempt/60-second rate limit, and generic
link errors. State that two PIN digits are acceptable only for the localhost
read-only MVP and must change before write capabilities.

- [ ] **Step 2: Rewrite the development runbook**

The runbook must instruct testers to:

1. Launch the Extension Development Host once for contributor testing.
2. Read and click-copy the seven-digit status code.
3. Paste it explicitly in the Firefox panel.
4. Verify no browser selects an IDE automatically.
5. Stop/start the bridge from the adjacent status icon.
6. Verify the old code and token fail after restart.
7. Continue the existing CSS/SCSS Selected and Parent checks.

State that installed, terminal-free artifact verification is added in Plan 3.

- [ ] **Step 3: Search for legacy pairing names**

```powershell
rg -n "PairingStore|pairRequest|pairAccepted|pairingCode|showPairingCode|resetPairing|protocolVersion:\s*2|ProtocolCapability\.Pairing" packages extensions tools docs --glob "!docs/superpowers/**"
```

Expected: no production or current-documentation matches. Historical approved
specs and plans are excluded because they intentionally describe migrations.

- [ ] **Step 4: Run the complete runtime gate**

```powershell
corepack pnpm install
corepack pnpm build
corepack pnpm test
corepack pnpm test:integration
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm dlx web-ext@10.4.0 lint --source-dir extensions/firefox --ignore-files package.json pnpm-lock.yaml tsconfig.json esbuild.mjs "src/**" "test/**"
git diff --check
```

Expected: every command exits 0 and web-ext reports zero findings.

- [ ] **Step 5: Perform the Firefox development-host smoke test**

Follow `docs/mvp-verification.md`. Open two VS Code windows and verify distinct
ports/codes; explicitly link Firefox to one; confirm CSS/SCSS highlighting goes
only to that window; stop/start and verify the stale token never attaches to
the restarted instance.

- [ ] **Step 6: Request code review and fix important findings**

Review the full commit range against the approved design and this plan. Fix all
Critical and Important findings, rerun focused tests for each fix, then rerun
the complete runtime gate.

- [ ] **Step 7: Commit runtime documentation**

```powershell
git add docs/protocol.md docs/security.md docs/mvp-usage.md docs/mvp-verification.md
git commit -m "docs: verify window link runtime"
```

## Completion Checklist

- [ ] Protocol v2 and six-digit pairing messages are rejected.
- [ ] PINs preserve a leading zero and are never logged.
- [ ] Five failed attempts enforce one bridge-wide 60-second cooldown.
- [ ] Tokens are role-bound, instance-bound, memory-only, and revoked at stop.
- [ ] Clients wait for authentication acknowledgement before reporting connected.
- [ ] Exactly 100 managed ports are attempted.
- [ ] Every start creates a new PIN, instance ID, and token set.
- [ ] VS Code auto-starts and exposes separate copy and start/stop status actions.
- [ ] Firefox can explicitly link without scanning or automatic IDE selection.
- [ ] Existing CSS/SCSS selected and parent presentation remains green.
- [ ] Unit, integration, build, typecheck, lint, web-ext lint, and manual runtime checks pass.
