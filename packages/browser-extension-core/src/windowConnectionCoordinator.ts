import {
  ClientSourceSchema,
  type ClientSource,
} from "@browser2ide/protocol";
import {
  BrowserBridgeClient,
  BrowserProtocolError,
  type BrowserBridgeClientOptions,
  type BrowserConnectionState,
  type BrowserCredentials,
  type InspectPayload,
} from "./bridgeClient.js";
import {
  BrowserWindowLinkStore,
  type BrowserWindowLink,
} from "./browserWindowLinkStore.js";
import { parseLinkCode } from "./linkCode.js";

export type BrowserWindowConnectionState =
  | "notLinked"
  | "linking"
  | "linked"
  | "reconnecting"
  | "offline"
  | "rateLimited"
  | "error";

export interface PanelRegistration {
  readonly windowId: number;
  readonly tabId: number;
  readonly sourceId: string;
  readonly onStateChanged?: (state: BrowserWindowConnectionState) => void;
}

export interface WindowConnectionClient {
  link(pin: string): void;
  connect(credentials: BrowserCredentials): void;
  disconnect(): void;
  unlink(): void;
  sendInspect(payload: InspectPayload, sourceId?: string): boolean;
}

export type WindowConnectionClientFactory = (
  options: BrowserBridgeClientOptions,
) => WindowConnectionClient;

export interface WindowConnectionCoordinatorOptions {
  readonly store: BrowserWindowLinkStore;
  readonly createClient?: WindowConnectionClientFactory;
  readonly setTimeout?: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface RegistrationEntry {
  readonly registration: PanelRegistration;
}

interface PendingCodeLink {
  readonly kind: "code";
  readonly url: string;
  readonly port: number;
  readonly pin: string;
  readonly source: ClientSource;
}

interface PendingCredentialLink {
  readonly kind: "credentials";
  readonly link: BrowserWindowLink;
  readonly source: ClientSource;
}

type PendingLink = PendingCodeLink | PendingCredentialLink;

interface WindowRecord {
  readonly windowId: number;
  readonly registrations: Map<string, RegistrationEntry>;
  generation: number;
  state: BrowserWindowConnectionState;
  client?: WindowConnectionClient;
  clientToken?: object;
  clientConnected: boolean;
  connectionSource?: ClientSource;
  link?: BrowserWindowLink;
  pendingLink?: PendingLink;
  credentialsWritePending: boolean;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  reconnectAttempts: number;
}

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 5_000;
const inertRegistrationHandle = Object.freeze({ dispose(): void {} });

export class WindowConnectionCoordinator {
  private readonly store: BrowserWindowLinkStore;
  private readonly createClient: WindowConnectionClientFactory;
  private readonly scheduleTimer: NonNullable<
    WindowConnectionCoordinatorOptions["setTimeout"]
  >;
  private readonly cancelScheduledTimer: NonNullable<
    WindowConnectionCoordinatorOptions["clearTimeout"]
  >;
  private readonly records = new Map<number, WindowRecord>();
  private readonly sourceOwners = new Map<string, RegistrationEntry>();
  private readonly tabOwners = new Map<number, RegistrationEntry>();
  private readonly storeTails = new Map<number, Promise<void>>();
  private disposed = false;

  public constructor(options: WindowConnectionCoordinatorOptions) {
    this.store = options.store;
    this.createClient =
      options.createClient ?? ((clientOptions) => new BrowserBridgeClient(clientOptions));
    this.scheduleTimer = options.setTimeout ?? setTimeout;
    this.cancelScheduledTimer = options.clearTimeout ?? clearTimeout;
  }

  public async linkWindow(
    windowId: number,
    code: string,
    source: ClientSource,
  ): Promise<void> {
    this.assertActive();
    assertWindowId(windowId);
    const parsedCode = parseLinkCode(code);
    const connectionSource = validatedConnectionSource(source);
    const record = this.recordFor(windowId);
    const generation = this.invalidate(record);

    this.revokeClient(record);
    record.link = undefined;
    record.pendingLink = undefined;
    record.connectionSource = connectionSource;
    record.credentialsWritePending = false;
    record.reconnectAttempts = 0;
    this.setState(record, "linking");

    try {
      await this.enqueueStore(windowId, () => this.store.remove(windowId));
    } catch (error) {
      if (this.isCurrent(record, generation)) {
        this.setState(record, "error");
      }
      throw asError(error);
    }
    if (!this.isCurrent(record, generation)) {
      return;
    }

    const pendingLink: PendingCodeLink = {
      kind: "code",
      url: parsedCode.url,
      port: parsedCode.port,
      pin: parsedCode.pin,
      source: connectionSource,
    };
    record.pendingLink = pendingLink;
    if (record.registrations.size > 0) {
      this.openClient(
        record,
        generation,
        pendingLink.url,
        connectionSource,
        (client) => client.link(pendingLink.pin),
      );
    }
  }

  public async unlinkWindow(windowId: number): Promise<void> {
    this.assertActive();
    assertWindowId(windowId);
    const record = this.records.get(windowId);
    let generation: number | undefined;
    if (record) {
      generation = this.invalidate(record);
      this.revokeClient(record);
      record.link = undefined;
      record.pendingLink = undefined;
      record.connectionSource = undefined;
      record.credentialsWritePending = false;
      record.reconnectAttempts = 0;
      this.setState(record, "notLinked");
    }

    try {
      await this.enqueueStore(windowId, () => this.store.remove(windowId));
    } catch (error) {
      if (
        record &&
        generation !== undefined &&
        this.isCurrent(record, generation)
      ) {
        this.setState(record, "error");
      }
      throw asError(error);
    }
  }

  public registerPanel(registration: PanelRegistration): { dispose(): void } {
    if (
      this.disposed ||
      !isValidRegistration(registration) ||
      this.sourceOwners.has(registration.sourceId) ||
      this.tabOwners.has(registration.tabId)
    ) {
      return inertRegistrationHandle;
    }

    const record = this.recordFor(registration.windowId);
    const entry: RegistrationEntry = { registration };
    record.registrations.set(registration.sourceId, entry);
    this.sourceOwners.set(registration.sourceId, entry);
    this.tabOwners.set(registration.tabId, entry);
    notifyRegistration(entry, record.state);

    if (record.registrations.size === 1) {
      this.activateFirstPanel(record, entry);
    }

    return {
      dispose: () => this.disposeRegistration(record, entry),
    };
  }

  public publishInspect(
    windowId: number,
    sourceId: string,
    payload: InspectPayload,
  ): boolean {
    const record = this.records.get(windowId);
    const entry = record?.registrations.get(sourceId);
    if (
      this.disposed ||
      !record ||
      record.state !== "linked" ||
      !record.clientConnected ||
      !record.client ||
      !entry
    ) {
      return false;
    }

    try {
      return record.client.sendInspect(
        {
          ...payload,
          metadata: {
            ...payload.metadata,
            browserWindowId: entry.registration.windowId,
            tabId: entry.registration.tabId,
          },
        },
        sourceId,
      );
    } catch {
      this.setState(record, "error");
      return false;
    }
  }

  public state(windowId: number): BrowserWindowConnectionState {
    return this.records.get(windowId)?.state ?? "notLinked";
  }

  public async removeWindow(windowId: number): Promise<void> {
    assertWindowId(windowId);
    const record = this.records.get(windowId);
    if (record) {
      this.invalidate(record);
      this.revokeClient(record);
      this.releaseRegistrations(record);
      record.link = undefined;
      record.pendingLink = undefined;
      record.connectionSource = undefined;
      record.credentialsWritePending = false;
      this.setState(record, "notLinked");
      this.records.delete(windowId);
    }

    await this.enqueueStore(windowId, () => this.store.remove(windowId));
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    for (const record of this.records.values()) {
      this.invalidate(record);
      this.disconnectClient(record);
      this.releaseRegistrations(record);
      if (record.credentialsWritePending && !record.link) {
        void this.enqueueStore(record.windowId, () =>
          this.store.remove(record.windowId),
        ).catch(() => undefined);
      }
      record.pendingLink = undefined;
      record.credentialsWritePending = false;
    }
    this.records.clear();
    this.sourceOwners.clear();
    this.tabOwners.clear();
  }

  private activateFirstPanel(
    record: WindowRecord,
    entry: RegistrationEntry,
  ): void {
    if (record.client) {
      if (
        record.state !== "linked" &&
        record.state !== "linking" &&
        record.state !== "reconnecting" &&
        this.hasReconnectIntent(record)
      ) {
        this.scheduleReconnect(record, record.generation, record.clientToken);
      }
      return;
    }

    if (
      record.state === "linking" &&
      !record.pendingLink &&
      !record.link
    ) {
      return;
    }

    if (record.pendingLink) {
      const pendingLink = record.pendingLink;
      record.connectionSource = pendingLink.source;
      this.setState(record, "linking");
      if (pendingLink.kind === "code") {
        this.openClient(
          record,
          record.generation,
          pendingLink.url,
          pendingLink.source,
          (client) => client.link(pendingLink.pin),
        );
      } else {
        this.openClient(
          record,
          record.generation,
          pendingLink.link.url,
          pendingLink.source,
          (client) => client.connect(credentialsFor(pendingLink.link)),
        );
      }
      return;
    }

    const source =
      record.connectionSource ?? panelConnectionSource(entry.registration);
    if (record.link) {
      const generation = ++record.generation;
      record.connectionSource = source;
      this.setState(record, "linking");
      this.openClient(record, generation, record.link.url, source, (client) =>
        client.connect(credentialsFor(record.link as BrowserWindowLink)),
      );
      return;
    }

    const generation = ++record.generation;
    void this.loadStoredLink(record, generation, source);
  }

  private async loadStoredLink(
    record: WindowRecord,
    generation: number,
    source: ClientSource,
  ): Promise<void> {
    let link: BrowserWindowLink | undefined;
    try {
      link = await this.enqueueStore(record.windowId, () =>
        this.store.load(record.windowId),
      );
    } catch {
      if (this.isCurrent(record, generation)) {
        this.setState(record, "error");
      }
      return;
    }

    if (
      !this.isCurrent(record, generation) ||
      record.registrations.size === 0
    ) {
      return;
    }
    if (!link) {
      this.setState(record, "notLinked");
      return;
    }

    record.link = link;
    record.connectionSource = source;
    this.setState(record, "linking");
    this.openClient(record, generation, link.url, source, (client) =>
      client.connect(credentialsFor(link)),
    );
  }

  private openClient(
    record: WindowRecord,
    generation: number,
    url: string,
    source: ClientSource,
    start: (client: WindowConnectionClient) => void,
  ): void {
    if (!this.isCurrent(record, generation)) {
      return;
    }

    const token = {};
    record.clientToken = token;
    record.clientConnected = false;
    let client: WindowConnectionClient;
    try {
      client = this.createClient({
        url,
        sourceId: source.id,
        source,
        autoReconnect: false,
        onCredentials: (credentials) => {
          void this.persistCredentials(record, generation, token, credentials);
        },
        onStateChanged: (state) =>
          this.handleClientState(record, generation, token, state),
        onError: (error) =>
          this.handleClientError(record, generation, token, error),
      });
    } catch {
      if (this.isCurrentToken(record, generation, token)) {
        record.clientToken = undefined;
        this.setState(record, "error");
      }
      return;
    }

    if (!this.isCurrentToken(record, generation, token)) {
      safeDisconnect(client);
      return;
    }
    record.client = client;
    try {
      start(client);
    } catch {
      if (this.isCurrentToken(record, generation, token)) {
        this.disconnectClient(record);
        this.setState(record, "error");
      }
    }
  }

  private async persistCredentials(
    record: WindowRecord,
    generation: number,
    token: object,
    credentials: BrowserCredentials,
  ): Promise<void> {
    if (
      !this.isCurrentToken(record, generation, token) ||
      record.credentialsWritePending ||
      record.pendingLink?.kind !== "code"
    ) {
      return;
    }

    const pendingCode = record.pendingLink;
    const link: BrowserWindowLink = {
      url: pendingCode.url,
      port: pendingCode.port,
      sessionId: credentials.sessionId,
      bridgeInstanceId: credentials.bridgeInstanceId,
      authToken: credentials.authToken,
    };
    record.pendingLink = {
      kind: "credentials",
      link,
      source: pendingCode.source,
    };
    record.credentialsWritePending = true;

    try {
      await this.enqueueStore(record.windowId, async () => {
        if (this.isCurrentToken(record, generation, token)) {
          await this.store.save(record.windowId, link);
        }
      });
    } catch {
      if (this.isCurrentToken(record, generation, token)) {
        record.credentialsWritePending = false;
        record.pendingLink = undefined;
        this.disconnectClient(record);
        this.setState(record, "error");
        void this.enqueueStore(record.windowId, () =>
          this.store.remove(record.windowId),
        ).catch(() => undefined);
      }
      return;
    }

    if (!this.isCurrentToken(record, generation, token)) {
      return;
    }
    record.credentialsWritePending = false;
    record.link = link;
    record.pendingLink = undefined;
    if (record.clientConnected) {
      this.setState(record, "linked");
    }
  }

  private handleClientState(
    record: WindowRecord,
    generation: number,
    token: object,
    state: BrowserConnectionState,
  ): void {
    if (!this.isCurrentToken(record, generation, token)) {
      return;
    }

    switch (state) {
      case "connecting":
      case "linking":
        if (record.state !== "reconnecting") {
          this.setState(record, "linking");
        }
        return;
      case "reconnecting":
        this.setState(record, "reconnecting");
        return;
      case "connected":
        record.clientConnected = true;
        record.reconnectAttempts = 0;
        this.cancelReconnect(record);
        if (record.link && !record.credentialsWritePending) {
          this.setState(record, "linked");
        }
        return;
      case "disconnected":
        record.clientConnected = false;
        if (record.registrations.size > 0 && this.hasReconnectIntent(record)) {
          this.scheduleReconnect(record, generation, token);
        } else {
          this.setState(record, record.link ? "offline" : "notLinked");
        }
        return;
      case "error":
        record.clientConnected = false;
        this.setState(record, "error");
    }
  }

  private handleClientError(
    record: WindowRecord,
    generation: number,
    token: object,
    error: Error,
  ): void {
    if (
      !this.isCurrentToken(record, generation, token) ||
      !(error instanceof BrowserProtocolError)
    ) {
      return;
    }

    if (
      error.code === "auth.instanceChanged" ||
      error.code === "auth.tokenRejected"
    ) {
      this.rejectAuthentication(record);
      return;
    }
    if (error.code === "link.rateLimited") {
      this.stopTerminalAttempt(record, "rateLimited");
      return;
    }
    if (
      error.code === "link.invalidCode" ||
      error.code === "link.unreachable" ||
      error.code === "link.rejected"
    ) {
      this.stopTerminalAttempt(record, "error");
      return;
    }
    if (error.code === "bridge.offline") {
      this.setState(record, "offline");
    }
  }

  private rejectAuthentication(record: WindowRecord): void {
    const generation = this.invalidate(record);
    this.disconnectClient(record);
    record.link = undefined;
    record.pendingLink = undefined;
    record.connectionSource = undefined;
    record.credentialsWritePending = false;
    record.reconnectAttempts = 0;
    this.setState(record, "offline");
    void this.enqueueStore(record.windowId, () =>
      this.store.remove(record.windowId),
    ).catch(() => {
      if (this.isCurrent(record, generation)) {
        this.setState(record, "error");
      }
    });
  }

  private stopTerminalAttempt(
    record: WindowRecord,
    state: "rateLimited" | "error",
  ): void {
    this.invalidate(record);
    this.disconnectClient(record);
    record.pendingLink = undefined;
    record.credentialsWritePending = false;
    record.reconnectAttempts = 0;
    this.setState(record, state);
  }

  private scheduleReconnect(
    record: WindowRecord,
    generation: number,
    token: object | undefined,
  ): void {
    if (
      !token ||
      record.reconnectTimer !== undefined ||
      record.registrations.size === 0 ||
      !this.hasReconnectIntent(record) ||
      !record.client ||
      !this.isCurrentToken(record, generation, token)
    ) {
      return;
    }

    this.setState(record, "reconnecting");
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** record.reconnectAttempts,
      RECONNECT_MAX_DELAY_MS,
    );
    record.reconnectAttempts += 1;
    record.reconnectTimer = this.scheduleTimer(() => {
      record.reconnectTimer = undefined;
      if (!this.isCurrentToken(record, generation, token)) {
        return;
      }
      const client = record.client;
      const intent = record.link ??
        (record.pendingLink?.kind === "credentials"
          ? record.pendingLink.link
          : undefined);
      try {
        if (intent) {
          client?.connect(credentialsFor(intent));
        } else if (record.pendingLink?.kind === "code") {
          client?.link(record.pendingLink.pin);
        }
      } catch {
        this.setState(record, "error");
        this.scheduleReconnect(record, generation, token);
      }
    }, delay);
  }

  private disposeRegistration(
    record: WindowRecord,
    entry: RegistrationEntry,
  ): void {
    const { registration } = entry;
    if (
      this.records.get(record.windowId) !== record ||
      record.registrations.get(registration.sourceId) !== entry
    ) {
      return;
    }

    record.registrations.delete(registration.sourceId);
    if (this.sourceOwners.get(registration.sourceId) === entry) {
      this.sourceOwners.delete(registration.sourceId);
    }
    if (this.tabOwners.get(registration.tabId) === entry) {
      this.tabOwners.delete(registration.tabId);
    }
    if (record.registrations.size > 0) {
      return;
    }

    this.invalidate(record);
    this.disconnectClient(record);
    if (!record.link) {
      record.pendingLink = undefined;
      record.connectionSource = undefined;
      record.credentialsWritePending = false;
    }
    record.reconnectAttempts = 0;
    this.setState(record, record.link ? "offline" : "notLinked");
  }

  private releaseRegistrations(record: WindowRecord): void {
    for (const entry of record.registrations.values()) {
      const { registration } = entry;
      if (this.sourceOwners.get(registration.sourceId) === entry) {
        this.sourceOwners.delete(registration.sourceId);
      }
      if (this.tabOwners.get(registration.tabId) === entry) {
        this.tabOwners.delete(registration.tabId);
      }
    }
    record.registrations.clear();
  }

  private recordFor(windowId: number): WindowRecord {
    const existing = this.records.get(windowId);
    if (existing) {
      return existing;
    }
    const record: WindowRecord = {
      windowId,
      registrations: new Map(),
      generation: 0,
      state: "notLinked",
      clientConnected: false,
      credentialsWritePending: false,
      reconnectAttempts: 0,
    };
    this.records.set(windowId, record);
    return record;
  }

  private invalidate(record: WindowRecord): number {
    record.generation += 1;
    this.cancelReconnect(record);
    return record.generation;
  }

  private revokeClient(record: WindowRecord): void {
    const client = record.client;
    record.client = undefined;
    record.clientToken = undefined;
    record.clientConnected = false;
    if (!client) {
      return;
    }
    try {
      client.unlink();
    } catch {
      safeDisconnect(client);
    }
  }

  private disconnectClient(record: WindowRecord): void {
    const client = record.client;
    record.client = undefined;
    record.clientToken = undefined;
    record.clientConnected = false;
    if (client) {
      safeDisconnect(client);
    }
  }

  private cancelReconnect(record: WindowRecord): void {
    if (record.reconnectTimer === undefined) {
      return;
    }
    this.cancelScheduledTimer(record.reconnectTimer);
    record.reconnectTimer = undefined;
  }

  private hasReconnectIntent(record: WindowRecord): boolean {
    return record.link !== undefined || record.pendingLink !== undefined;
  }

  private isCurrent(record: WindowRecord, generation: number): boolean {
    return (
      !this.disposed &&
      this.records.get(record.windowId) === record &&
      record.generation === generation
    );
  }

  private isCurrentToken(
    record: WindowRecord,
    generation: number,
    token: object,
  ): boolean {
    return (
      this.isCurrent(record, generation) && record.clientToken === token
    );
  }

  private setState(
    record: WindowRecord,
    state: BrowserWindowConnectionState,
  ): void {
    if (record.state === state) {
      return;
    }
    record.state = state;
    for (const entry of [...record.registrations.values()]) {
      notifyRegistration(entry, state);
    }
  }

  private enqueueStore<T>(
    windowId: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.storeTails.get(windowId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.storeTails.set(windowId, tail);
    void tail.then(() => {
      if (this.storeTails.get(windowId) === tail) {
        this.storeTails.delete(windowId);
      }
    });
    return result;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("Window connection coordinator is disposed");
    }
  }
}

function credentialsFor(link: BrowserWindowLink): BrowserCredentials {
  return {
    sessionId: link.sessionId,
    bridgeInstanceId: link.bridgeInstanceId,
    authToken: link.authToken,
  };
}

function panelConnectionSource(registration: PanelRegistration): ClientSource {
  return {
    role: "browser",
    id: registration.sourceId,
    metadata: {},
  };
}

function validatedConnectionSource(source: ClientSource): ClientSource {
  const parsed = ClientSourceSchema.parse(source);
  if (parsed.role !== "browser" && parsed.role !== "simulator") {
    throw new Error("Window links require a browser or simulator source");
  }
  return parsed;
}

function isValidRegistration(
  registration: PanelRegistration,
): registration is PanelRegistration {
  if (!registration || typeof registration !== "object") {
    return false;
  }
  if (
    !isWindowId(registration.windowId) ||
    !isWindowId(registration.tabId) ||
    typeof registration.sourceId !== "string" ||
    registration.sourceId.trim().length === 0
  ) {
    return false;
  }
  return ClientSourceSchema.safeParse({
    role: "browser",
    id: registration.sourceId,
    metadata: {},
  }).success;
}

function assertWindowId(windowId: number): void {
  if (!isWindowId(windowId)) {
    throw new Error("Browser window ID must be a nonnegative safe integer");
  }
}

function isWindowId(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function notifyRegistration(
  entry: RegistrationEntry,
  state: BrowserWindowConnectionState,
): void {
  try {
    entry.registration.onStateChanged?.(state);
  } catch {
    // A panel callback cannot break connection ownership for other panels.
  }
}

function safeDisconnect(client: WindowConnectionClient): void {
  try {
    client.disconnect();
  } catch {
    // Teardown remains best effort when an injected transport is already gone.
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
