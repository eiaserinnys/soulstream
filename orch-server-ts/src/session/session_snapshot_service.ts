import type { InMemoryNodeRegistry } from "../node/registry.js";
import type { CachedNodeSession } from "../node/session_cache.js";
import type { SessionStreamSnapshot } from "../sse/sse_replay_routes.js";
import { serializeSessionRow } from "../runtime/live_session_serialization.js";

export type SessionSnapshotQuery = {
  session_ids?: string[];
  folderId?: string;
  folder_id?: string;
  session_type?: string;
  feed_only?: boolean;
  offset?: number;
  limit?: number;
  cursor?: string;
};

export type SessionSnapshotListResponse = {
  sessions: Record<string, unknown>[];
  sessionList: Record<string, unknown>[];
  total: number;
  cursor: string | null;
  nextCursor: string | null;
  hasMore: boolean;
};

export type SessionSnapshotRecord = Record<string, unknown> & {
  agent_session_id: string;
  agentSessionId: string;
  nodeId: string;
  connected: boolean;
  fresh: boolean;
};

export type SessionSnapshotServiceOptions = {
  registry: InMemoryNodeRegistry;
};

const DEFAULT_LIMIT = 50;
export const SESSION_SNAPSHOT_MAX_LIMIT = 200;
export const SESSION_SNAPSHOT_MAX_TARGET_IDS = SESSION_SNAPSHOT_MAX_LIMIT;

export class SessionSnapshotService {
  private readonly registry: InMemoryNodeRegistry;

  constructor(options: SessionSnapshotServiceOptions) {
    this.registry = options.registry;
  }

  listSessions(query: SessionSnapshotQuery = {}): SessionSnapshotListResponse {
    const offset = resolveSessionSnapshotOffset(query);
    const limit = resolveSessionSnapshotLimit(query.limit);
    const normalizedQuery = {
      ...query,
      session_ids: resolveSessionSnapshotIds(query.session_ids),
    };
    const filtered = this.registry.sessionCache
      .listSessions()
      .map((session) => ({
        session,
        snapshot: this.projectSession(session),
      }))
      .filter(({ snapshot }) => matchesQuery(snapshot, normalizedQuery))
      .sort((left, right) => compareSessions(left.session, right.session));
    const page = filtered
      .slice(offset, offset + limit)
      .map((entry) => entry.snapshot);
    return buildSessionSnapshotListResponse(page, filtered.length, offset, limit);
  }

  loadSessionStreamSnapshot(): Promise<SessionStreamSnapshot> {
    const snapshot = this.listSessions();
    return Promise.resolve({
      sessions: snapshot.sessions,
      total: snapshot.total,
    });
  }

  private projectSession(session: CachedNodeSession): SessionSnapshotRecord {
    const owner = this.registry.findSessionOwner(session.agentSessionId);
    return {
      ...session.payload,
      ...serializeSessionRow(
        {
          ...session.payload,
          session_id: session.agentSessionId,
          node_id: session.nodeId,
          status: session.status,
          last_event_id: session.lastEventId,
        },
        { registry: this.registry },
      ),
      agent_session_id: session.agentSessionId,
      agentSessionId: session.agentSessionId,
      nodeId: session.nodeId,
      status: session.status,
      last_event_id: session.lastEventId,
      connected: owner?.connected ?? false,
      fresh: session.fresh,
    };
  }
}

export function resolveSessionSnapshotOffset(query: SessionSnapshotQuery): number {
  if (query.cursor !== undefined && query.cursor.length > 0) {
    const cursorOffset = Number.parseInt(query.cursor, 10);
    return Number.isFinite(cursorOffset) && cursorOffset >= 0 ? cursorOffset : 0;
  }
  return query.offset !== undefined &&
    Number.isInteger(query.offset) &&
    query.offset >= 0
    ? query.offset
    : 0;
}

export function resolveSessionSnapshotLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 0) return DEFAULT_LIMIT;
  if (limit === 0) return SESSION_SNAPSHOT_MAX_LIMIT;
  return Math.min(limit, SESSION_SNAPSHOT_MAX_LIMIT);
}

export function resolveSessionSnapshotIds(
  sessionIds: string[] | undefined,
): string[] | undefined {
  return sessionIds?.slice(0, SESSION_SNAPSHOT_MAX_TARGET_IDS);
}

export function buildSessionSnapshotListResponse(
  sessions: Record<string, unknown>[],
  total: number,
  offset: number,
  limit: number,
): SessionSnapshotListResponse {
  const loadedCount = offset + sessions.length;
  const hasMore = limit > 0 && loadedCount < total;
  const nextCursor = hasMore ? String(offset + limit) : null;
  return {
    sessions,
    sessionList: sessions,
    total,
    cursor: nextCursor,
    nextCursor,
    hasMore,
  };
}

function matchesQuery(
  session: SessionSnapshotRecord,
  query: SessionSnapshotQuery,
): boolean {
  if (
    query.session_ids !== undefined &&
    !query.session_ids.includes(session.agentSessionId)
  ) {
    return false;
  }
  const folderId = query.folder_id ?? query.folderId;
  if (
    folderId !== undefined &&
    fieldValue(session, "folder_id", "folderId") !== folderId
  ) {
    return false;
  }
  if (
    query.session_type !== undefined &&
    fieldValue(session, "session_type", "sessionType") !== query.session_type
  ) {
    return false;
  }
  if (
    query.feed_only === true &&
    fieldValue(session, "session_type", "sessionType") === "llm"
  ) {
    return false;
  }
  return true;
}

function fieldValue(
  session: SessionSnapshotRecord,
  snakeKey: string,
  camelKey: string,
): unknown {
  return session[snakeKey] ?? session[camelKey];
}

function compareSessions(left: CachedNodeSession, right: CachedNodeSession): number {
  const updatedDiff = right.updatedAtMs - left.updatedAtMs;
  if (updatedDiff !== 0) return updatedDiff;
  return left.agentSessionId.localeCompare(right.agentSessionId);
}
