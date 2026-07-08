import type { InMemoryNodeRegistry } from "../node/registry.js";
import type { CachedNodeSession } from "../node/session_cache.js";
import type { SessionStreamSnapshot } from "../sse/sse_replay_routes.js";

export type SessionSnapshotQuery = {
  folderId?: string;
  folder_id?: string;
  session_type?: string;
  feed_only?: boolean;
  offset?: number;
  limit?: number;
  cursor?: string;
};

export type SessionSnapshotListResponse = {
  sessions: SessionSnapshotRecord[];
  sessionList: SessionSnapshotRecord[];
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
const MAX_LIMIT = 200;

export class SessionSnapshotService {
  private readonly registry: InMemoryNodeRegistry;

  constructor(options: SessionSnapshotServiceOptions) {
    this.registry = options.registry;
  }

  listSessions(query: SessionSnapshotQuery = {}): SessionSnapshotListResponse {
    const offset = resolveOffset(query);
    const limit = resolveLimit(query.limit);
    const filtered = this.registry.sessionCache
      .listSessions()
      .map((session) => ({
        session,
        snapshot: this.projectSession(session),
      }))
      .filter(({ snapshot }) => matchesQuery(snapshot, query))
      .sort((left, right) => compareSessions(left.session, right.session));
    const page =
      limit === 0
        ? []
        : filtered.slice(offset, offset + limit).map((entry) => entry.snapshot);
    const loadedCount = offset + page.length;
    const hasMore = limit > 0 && loadedCount < filtered.length;
    const nextCursor = hasMore ? String(offset + limit) : null;

    return {
      sessions: page,
      sessionList: page,
      total: filtered.length,
      cursor: nextCursor,
      nextCursor,
      hasMore,
    };
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

function resolveOffset(query: SessionSnapshotQuery): number {
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

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 0) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

function matchesQuery(
  session: SessionSnapshotRecord,
  query: SessionSnapshotQuery,
): boolean {
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
