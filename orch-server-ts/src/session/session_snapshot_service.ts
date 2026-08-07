import type { InMemoryNodeRegistry } from "../node/registry.js";
import type { CachedNodeSession } from "../node/session_cache.js";
import type { SessionStreamSnapshot } from "../sse/sse_replay_routes.js";
import { serializeSessionRow } from "../runtime/live_session_serialization.js";
import type { AgentProfileIdentityOverlay } from "../node/agent_profile_lookup.js";

export type SessionSnapshotQuery = {
  session_ids?: string[];
  folderId?: string;
  folder_id?: string;
  session_type?: string;
  search?: string;
  node_id?: string;
  status?: string[];
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
  agentProfiles?: () => readonly AgentProfileIdentityOverlay[];
};

const DEFAULT_LIMIT = 50;
export const SESSION_SNAPSHOT_MAX_LIMIT = 200;
export const SESSION_SNAPSHOT_MAX_TARGET_IDS = SESSION_SNAPSHOT_MAX_LIMIT;

export class SessionSnapshotService {
  private readonly registry: InMemoryNodeRegistry;
  private readonly agentProfiles: () => readonly AgentProfileIdentityOverlay[];

  constructor(options: SessionSnapshotServiceOptions) {
    this.registry = options.registry;
    this.agentProfiles = options.agentProfiles ?? (() => []);
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
        {
          registry: this.registry,
          agentProfiles: this.agentProfiles(),
        },
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
    query.node_id !== undefined &&
    fieldValue(session, "node_id", "nodeId") !== query.node_id
  ) {
    return false;
  }
  if (
    query.status !== undefined &&
    !query.status.includes(String(fieldValue(session, "status", "status") ?? ""))
  ) {
    return false;
  }
  if (
    query.feed_only === true &&
    fieldValue(session, "session_type", "sessionType") === "llm"
  ) {
    return false;
  }
  if (query.search !== undefined && !matchesMetadataSearch(session, query.search)) {
    return false;
  }
  return true;
}

function matchesMetadataSearch(
  session: SessionSnapshotRecord,
  search: string,
): boolean {
  const normalized = search.trim().toLocaleLowerCase();
  if (normalized.length === 0) return true;
  return [
    fieldValue(session, "display_name", "displayName"),
    session.title,
    session.agentSessionId,
    fieldValue(session, "folder_name", "folderName"),
    fieldValue(session, "folder_id", "folderId"),
    fieldValue(session, "node_id", "nodeId"),
  ].some((value) =>
    typeof value === "string" &&
    value.toLocaleLowerCase().includes(normalized)
  );
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
