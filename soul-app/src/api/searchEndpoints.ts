import type { ApiRequestContext } from './clientCore';
import { toSession } from './mappers';
import type { Session } from './types';

export interface SessionMetadataSearchParams {
  query: string;
  folderId?: string | null;
  nodeId?: string | null;
  statuses?: readonly string[];
  backends?: readonly string[];
  updatedAfter?: string | null;
  limit?: number;
  offset?: number;
}

export interface SessionMetadataSearchPage {
  sessions: Session[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface SessionMessageSearchParams {
  query: string;
  topK?: number;
  eventCategories?: readonly string[] | null;
  searchSessionId?: boolean;
  includeTurnSummaries?: boolean;
  includeHighlight?: boolean;
  includeStory?: boolean;
  includeSessionResults?: boolean;
  sessionSearchMode?: 'lexical' | 'expanded';
  sessionFilters?: SessionSearchFilters;
}

export interface SessionSearchFilters {
  folderId?: string | null;
  nodeId?: string | null;
  statuses?: readonly string[];
  backends?: readonly string[];
  updatedAfter?: string | null;
}

export type SearchMatchSource =
  | 'message'
  | 'turn_summary'
  | 'highlight'
  | 'story';

export interface SessionMessageSearchResult {
  sessionId: string;
  eventId: number;
  eventType: string;
  matchSource: SearchMatchSource;
  preview: string;
  score: number;
}

export interface SessionMessageSearchResponse {
  results: SessionMessageSearchResult[];
  navigationResults: SearchNavigationResult[];
  sessionResults: SessionSearchProjection[];
  searchStatus: SessionMessageSearchStatus | null;
}

export interface SessionMessageSearchStatus {
  search?: {
    status: 'partial';
    stage: 'lexical' | 'semantic' | 'navigation';
    reason: 'timeout' | 'cancelled';
  };
  queryExpansion: {
    status: 'expanded' | 'skipped' | 'partial';
    reason?: 'configuration' | 'timeout' | 'cancelled' | 'model_error';
    latencyMs: number;
  };
  searchLatencyMs: number | null;
  dbCancelFailed: boolean;
}

export interface SessionSearchProjection {
  sessionId: string;
  title: string;
  excerpt: string;
  folderId: string | null;
  nodeId: string | null;
  status: string | null;
  backend: string | null;
  updatedAt: string | null;
  folderTitle: string | null;
  parentSessionId: string | null;
  bestMatch: {
    eventId: number | null;
    matchSource: string;
    excerpt: string;
  };
  sessionUrl: string;
}

export type SearchNavigationResult = {
    kind: 'folder';
    id: string;
    title: string;
    folderId: string;
    projectPageId: string;
  };

type SessionListPayload = {
  sessions?: Array<Record<string, unknown>>;
  sessionList?: Array<Record<string, unknown>>;
  total?: number;
  hasMore?: boolean;
  nextCursor?: string | null;
};

type MessageSearchPayload = {
  results?: Array<Record<string, unknown>>;
  navigation_results?: Array<Record<string, unknown>>;
  session_results?: Array<Record<string, unknown>>;
  search_status?: Record<string, unknown>;
};

export function createSearchEndpoints({
  base,
  authFetch,
  readJson,
}: ApiRequestContext) {
  return {
    searchSessions: async (
      params: SessionMetadataSearchParams,
      signal?: AbortSignal,
    ): Promise<SessionMetadataSearchPage> => {
      const query = new URLSearchParams({ search: params.query });
      if (params.folderId) query.set('folder_id', params.folderId);
      if (params.nodeId) query.set('node_id', params.nodeId);
      if (params.statuses && params.statuses.length > 0) {
        query.set('status', params.statuses.join(','));
      }
      if (params.backends && params.backends.length > 0) {
        query.set('backend', params.backends.join(','));
      }
      if (params.updatedAfter) query.set('updated_after', params.updatedAfter);
      if (params.limit !== undefined) query.set('limit', String(params.limit));
      if (params.offset !== undefined) query.set('offset', String(params.offset));
      const response = await authFetch(`${base}/api/sessions?${query.toString()}`, {
        signal,
      });
      const payload = await readJson<SessionListPayload>(response, 'searchSessions');
      const rows = Array.isArray(payload.sessions)
        ? payload.sessions
        : Array.isArray(payload.sessionList)
          ? payload.sessionList
          : [];
      const sessions = rows
        .map(toSession)
        .filter((session) => Boolean(session.agentSessionId));
      return {
        sessions,
        total: typeof payload.total === 'number' ? payload.total : sessions.length,
        hasMore: payload.hasMore === true,
        nextCursor: typeof payload.nextCursor === 'string' ? payload.nextCursor : null,
      };
    },

    searchSessionMessages: async (
      params: SessionMessageSearchParams,
      signal?: AbortSignal,
    ): Promise<SessionMessageSearchResponse> => {
      const query = new URLSearchParams({
        q: params.query,
        top_k: String(params.topK ?? 20),
        search_session_id: String(params.searchSessionId ?? true),
        include_session_results: String(params.includeSessionResults ?? true),
      });
      if (params.sessionSearchMode) {
        query.set('session_search_mode', params.sessionSearchMode);
      }
      if (params.sessionFilters) {
        const filters = params.sessionFilters;
        if (filters.folderId) query.set('session_folder_id', filters.folderId);
        if (filters.nodeId) query.set('session_node_id', filters.nodeId);
        if (filters.statuses && filters.statuses.length > 0) {
          query.set('session_statuses', filters.statuses.join(','));
        }
        if (filters.backends && filters.backends.length > 0) {
          query.set('session_backends', filters.backends.join(','));
        }
        if (filters.updatedAfter) query.set('session_updated_after', filters.updatedAfter);
      }
      if (
        params.eventCategories !== null &&
        params.eventCategories !== undefined
      ) {
        query.set('event_categories', params.eventCategories.join(','));
      }
      if (params.includeTurnSummaries) {
        query.set('include_turn_summaries', 'true');
      }
      if (params.includeHighlight) {
        query.set('include_highlight', 'true');
      }
      if (params.includeStory) {
        query.set('include_story', 'true');
      }
      const response = await authFetch(`${base}/cogito/search?${query.toString()}`, {
        signal,
      });
      const payload = await readJson<MessageSearchPayload>(
        response,
        'searchSessionMessages',
      );
      return {
        results: (payload.results ?? []).flatMap(toMessageSearchResult),
        navigationResults: (payload.navigation_results ?? [])
          .flatMap(toNavigationSearchResult),
        sessionResults: (payload.session_results ?? [])
          .flatMap(toSessionSearchProjection),
        searchStatus: toSessionMessageSearchStatus(payload.search_status),
      };
    },
  };
}

function toNavigationSearchResult(
  row: Record<string, unknown>,
): SearchNavigationResult[] {
  const kind = stringValue(row.kind);
  const id = stringValue(row.id);
  const title = stringValue(row.title);
  const folderId = stringValue(row.folder_id ?? row.folderId);
  const projectPageId = stringValue(row.project_page_id ?? row.projectPageId);
  if (!id || !title || !folderId || !projectPageId) return [];
  if (kind !== 'folder') return [];
  return [{ kind, id, title, folderId, projectPageId }];
}

function toMessageSearchResult(
  row: Record<string, unknown>,
): SessionMessageSearchResult[] {
  const sessionId = stringValue(row.session_id ?? row.sessionId);
  const eventId = numberValue(row.event_id ?? row.eventId);
  if (!sessionId || eventId === null) return [];
  return [{
    sessionId,
    eventId,
    eventType: stringValue(row.event_type ?? row.eventType) ?? 'message',
    matchSource: normalizeSearchMatchSource(
      row.match_source ?? row.matchSource,
      typeof __DEV__ !== 'undefined' && __DEV__,
    ),
    preview: stringValue(row.preview) ?? '',
    score: numberValue(row.score) ?? 0,
  }];
}

function toSessionSearchProjection(
  row: Record<string, unknown>,
): SessionSearchProjection[] {
  const sessionId = stringValue(row.session_id ?? row.sessionId);
  if (!sessionId) return [];
  const bestMatch = recordValue(row.best_match ?? row.bestMatch);
  return [{
    sessionId,
    title: stringValue(row.title) ?? '제목 없음',
    excerpt: stringValue(row.excerpt) ?? '',
    folderId: stringValue(row.folder_id ?? row.folderId),
    nodeId: stringValue(row.node_id ?? row.nodeId),
    status: stringValue(row.status),
    backend: stringValue(row.backend),
    updatedAt: stringValue(row.updated_at ?? row.updatedAt),
    folderTitle: stringValue(row.folder_title ?? row.folderTitle),
    parentSessionId: stringValue(row.parent_session_id ?? row.parentSessionId),
    bestMatch: {
      eventId: numberValue(bestMatch.event_id ?? bestMatch.eventId),
      matchSource: stringValue(bestMatch.match_source ?? bestMatch.matchSource) ?? 'session',
      excerpt: stringValue(bestMatch.excerpt) ?? stringValue(row.excerpt) ?? '',
    },
    sessionUrl: stringValue(row.session_url ?? row.sessionUrl) ?? '',
  }];
}

function toSessionMessageSearchStatus(
  value: unknown,
): SessionMessageSearchStatus | null {
  const status = recordValue(value);
  const expansion = recordValue(status.query_expansion);
  const expansionStatus = expansion.status;
  if (
    expansionStatus !== 'expanded'
    && expansionStatus !== 'skipped'
    && expansionStatus !== 'partial'
  ) return null;
  const reason = expansion.reason;
  const validReason = reason === 'configuration'
    || reason === 'timeout'
    || reason === 'cancelled'
    || reason === 'model_error';
  return {
    ...(validSearchStatus(status.search) ? { search: validSearchStatus(status.search)! } : {}),
    queryExpansion: {
      status: expansionStatus,
      ...(validReason ? { reason } : {}),
      latencyMs: numberValue(expansion.latency_ms) ?? 0,
    },
    searchLatencyMs: numberValue(status.search_latency_ms),
    dbCancelFailed: status.db_cancel === 'failed',
  };
}

function validSearchStatus(value: unknown): SessionMessageSearchStatus['search'] | null {
  const search = recordValue(value);
  if (search.status !== 'partial') return null;
  const stage = search.stage;
  if (stage !== 'lexical' && stage !== 'semantic' && stage !== 'navigation') return null;
  const reason = search.reason;
  if (reason !== 'timeout' && reason !== 'cancelled') return null;
  return { status: 'partial', stage, reason };
}

export function normalizeSearchMatchSource(
  value: unknown,
  strict: boolean,
): SearchMatchSource {
  if (value === undefined || value === null) {
    return 'message';
  }
  if (
    value === 'message'
    || value === 'turn_summary'
    || value === 'highlight'
    || value === 'story'
  ) {
    return value;
  }
  if (strict) {
    throw new Error(`[searchEndpoints] invalid match_source: ${String(value)}`);
  }
  return 'message';
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
