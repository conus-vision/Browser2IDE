import type { ResolvedReference } from "./sourceTypes.js";

export interface ReferenceSnapshot {
  readonly sessionId: string;
  readonly messageId: string;
  readonly references: readonly ResolvedReference[];
  readonly groups: ReadonlyMap<string, readonly ResolvedReference[]>;
}

const CONFIDENCE_PRIORITY: Record<ResolvedReference["confidence"], number> = {
  exact: 0,
  sourcemap: 1,
  instrumented: 2,
  heuristic: 3,
  unknown: 4,
};

const STATUS_PRIORITY: Record<ResolvedReference["status"], number> = {
  active: 0,
  matched: 1,
  overridden: 2,
  external: 3,
  unmapped: 4,
  error: 5,
};

export class ReferenceStore {
  private readonly byMessageId = new Map<string, ReferenceSnapshot>();
  private readonly latestMessageBySession = new Map<string, string>();

  replace(
    sessionId: string,
    messageId: string,
    references: readonly ResolvedReference[],
  ): ReferenceSnapshot {
    const previousMessageId = this.latestMessageBySession.get(sessionId);
    if (previousMessageId && previousMessageId !== messageId) {
      this.byMessageId.delete(previousMessageId);
    }

    const previousSnapshot = this.byMessageId.get(messageId);
    if (previousSnapshot && previousSnapshot.sessionId !== sessionId) {
      this.latestMessageBySession.delete(previousSnapshot.sessionId);
    }

    const sorted = [...references].sort(compareReferences);
    const snapshot: ReferenceSnapshot = {
      sessionId,
      messageId,
      references: sorted,
      groups: groupReferences(sorted),
    };

    this.byMessageId.set(messageId, snapshot);
    this.latestMessageBySession.set(sessionId, messageId);
    return snapshot;
  }

  getByMessageId(messageId: string): ReferenceSnapshot | undefined {
    return this.byMessageId.get(messageId);
  }

  getLatestForSession(sessionId: string): ReferenceSnapshot | undefined {
    const messageId = this.latestMessageBySession.get(sessionId);
    return messageId ? this.byMessageId.get(messageId) : undefined;
  }
}

export function referenceFileKey(reference: ResolvedReference): string {
  return reference.workspaceUri?.fsPath ?? reference.source.uri;
}

function compareReferences(
  left: ResolvedReference,
  right: ResolvedReference,
): number {
  return (
    CONFIDENCE_PRIORITY[left.confidence] -
      CONFIDENCE_PRIORITY[right.confidence] ||
    STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status] ||
    referenceFileKey(left).localeCompare(referenceFileKey(right)) ||
    left.source.line - right.source.line
  );
}

function groupReferences(
  references: readonly ResolvedReference[],
): ReadonlyMap<string, readonly ResolvedReference[]> {
  const groups = new Map<string, ResolvedReference[]>();

  for (const reference of references) {
    const key = referenceFileKey(reference);
    const group = groups.get(key) ?? [];
    group.push(reference);
    groups.set(key, group);
  }

  return groups;
}
