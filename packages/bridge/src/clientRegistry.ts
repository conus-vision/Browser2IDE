import { randomUUID } from "node:crypto";
import type { ClientRole, ClientSource } from "@browser2ide/protocol";

export interface BridgeConnection {
  send(payload: string): void;
  terminate(): void;
  close?: () => void;
}

export interface ClientRegistration {
  readonly connection: BridgeConnection;
  readonly source: ClientSource;
  readonly sessionId: string;
}

export interface RegisteredClient extends ClientRegistration {
  readonly id: string;
  missedPongs: number;
}

export class ClientRegistry {
  private readonly clients = new Map<string, RegisteredClient>();

  add(client: ClientRegistration): RegisteredClient {
    const entry: RegisteredClient = {
      ...client,
      id: randomUUID(),
      missedPongs: 0,
    };

    this.clients.set(entry.id, entry);
    return entry;
  }

  remove(id: string): void {
    this.clients.delete(id);
  }

  findBySessionAndRole(
    sessionId: string,
    role: ClientRole,
  ): RegisteredClient[] {
    return this.all().filter(
      (client) => client.sessionId === sessionId && client.source.role === role,
    );
  }

  markAlive(id: string): void {
    const client = this.clients.get(id);
    if (client) {
      client.missedPongs = 0;
    }
  }

  markPingSent(id: string): void {
    const client = this.clients.get(id);
    if (client) {
      client.missedPongs += 1;
    }
  }

  all(): RegisteredClient[] {
    return [...this.clients.values()];
  }
}
