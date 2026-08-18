import type {
  ListSessionSummaryRow,
  RunningSessionSummaryRow,
  OwnerNullRunningSessionRow,
  SessionRow,
  UpstreamSessionDumpRow,
} from "../db/session_db_types.js";
import type {
  SessionDigestSearchMatch,
  SessionSearchMetadata,
  SessionStoryTurnSummary,
  SessionStoryView,
  SessionTurnSummaryCounts,
} from "../db/session_story_types.js";
import {
  type HostClientConfig,
  PersistenceHostRequestError,
  PersistenceHostTransport,
} from "./persistence_host_clients.js";

export const SESSION_DATA_READ_OPERATIONS = [
  "get",
  "list_summary",
  "list_running",
  "owner_null_running_inventory",
  "upstream_dump",
  "event_count",
  "event_read_page",
  "event_read_one",
  "event_raw_page",
  "event_search",
  "event_session_id_search",
  "story_search_metadata",
  "turn_summary_count",
  "turn_summary_range",
  "digest_search",
  "story",
  "turn_excerpt",
  "resume_context",
] as const;

export interface SessionEventRow {
  id: number;
  session_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  searchable_text: string;
  created_at: Date;
}

export interface SessionEventDetailRow extends SessionEventRow {
  parent_event_id: number | null;
}

export interface SessionEventSearchRow extends SessionEventRow {
  score: number;
}

export interface SessionTurnExcerptItem {
  event_id: number;
  event_type: string;
  text: string;
  created_at: string;
}

export interface SessionTurnExcerptResult {
  totalEvents: number;
  turns: SessionTurnExcerptItem[];
}

export interface SessionResumeContext {
  session: SessionRow | null;
  folderSessions: { sessions: ListSessionSummaryRow[]; total: number };
  runningSessions: { sessions: RunningSessionSummaryRow[]; total: number };
  predecessor: {
    session: SessionRow;
    story: SessionStoryView;
    excerpt: SessionTurnExcerptResult | null;
  } | null;
}

export interface SessionDataHost {
  getSession(sessionId: string): Promise<SessionRow | null>;
  listSessionsSummary(params: {
    search?: string | null;
    limit: number;
    offset: number;
    folderId?: string | null;
    nodeId?: string | null;
  }): Promise<{ sessions: ListSessionSummaryRow[]; total: number }>;
  listRunningSessionsSummary(params: {
    limit: number;
    excludeSessionId?: string | null;
  }): Promise<{ sessions: RunningSessionSummaryRow[]; total: number }>;
  listOwnerNullRunningInventory(params: {
    nodeId: string;
    limit: number;
  }): Promise<OwnerNullRunningSessionRow[]>;
  listSessionsForUpstreamDump(params: {
    limit: number;
    offset: number;
    nodeId: string;
  }): Promise<{ sessions: UpstreamSessionDumpRow[]; total: number }>;
  countEvents(sessionId: string): Promise<number>;
  readEvents(sessionId: string, afterId: number, limit: number, eventTypes?: string[]): Promise<SessionEventRow[]>;
  readOneEvent(sessionId: string, eventId: number): Promise<SessionEventDetailRow | null>;
  streamEventsRaw(sessionId: string, afterId?: number): Promise<Array<{ id: number; event_type: string; payload_text: string }>>;
  searchEvents(query: string, sessionIds: string[] | null, limit: number, eventTypes?: string[] | null): Promise<SessionEventSearchRow[]>;
  searchEventsBySessionId(query: string, eventTypes: string[] | null, limit: number): Promise<SessionEventSearchRow[]>;
  getSessionSearchMetadata(sessionIds: string[]): Promise<Map<string, SessionSearchMetadata>>;
  countTurnSummaries(sessionId: string): Promise<SessionTurnSummaryCounts>;
  loadTurnSummaryRange(sessionId: string, fromTurnNumber: number, toTurnNumber: number | null, limit: number): Promise<SessionStoryTurnSummary[]>;
  searchSessionDigests(query: string, sessionIds: string[] | null, limit: number, includeHighlight: boolean, includeStory: boolean): Promise<SessionDigestSearchMatch[]>;
  getSessionStory(sessionId: string): Promise<SessionStoryView>;
  getTurnExcerpt(sessionId: string, maxResponseChars?: number): Promise<SessionTurnExcerptResult>;
  getResumeContext(sessionId: string, limit: number): Promise<SessionResumeContext>;
}

export class SessionDataHostError extends Error {
  readonly operation: string;
  readonly retryable: boolean;

  constructor(input: {
    operation: string;
    retryable: boolean;
    message: string;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "SessionDataHostError";
    this.operation = input.operation;
    this.retryable = input.retryable;
  }
}

export function isSessionDataHostError(error: unknown): error is SessionDataHostError {
  return error instanceof SessionDataHostError;
}

export class SessionDataHostClient implements SessionDataHost {
  private readonly transport: PersistenceHostTransport;

  constructor(config: HostClientConfig) {
    this.transport = new PersistenceHostTransport(config);
  }

  getSession(sessionId: string): Promise<SessionRow | null> {
    return this.turnCritical("get", [sessionId]);
  }

  listSessionsSummary(params: Parameters<SessionDataHost["listSessionsSummary"]>[0]): ReturnType<SessionDataHost["listSessionsSummary"]> {
    return this.interactive("list_summary", [params]);
  }

  listRunningSessionsSummary(params: Parameters<SessionDataHost["listRunningSessionsSummary"]>[0]): ReturnType<SessionDataHost["listRunningSessionsSummary"]> {
    return this.turnCritical("list_running", [params]);
  }

  listOwnerNullRunningInventory(params: Parameters<SessionDataHost["listOwnerNullRunningInventory"]>[0]): ReturnType<SessionDataHost["listOwnerNullRunningInventory"]> {
    return this.turnCritical("owner_null_running_inventory", [params]);
  }

  listSessionsForUpstreamDump(params: Parameters<SessionDataHost["listSessionsForUpstreamDump"]>[0]): ReturnType<SessionDataHost["listSessionsForUpstreamDump"]> {
    return this.interactive("upstream_dump", [params]);
  }

  countEvents(sessionId: string): Promise<number> {
    return this.interactive("event_count", [sessionId]);
  }

  readEvents(sessionId: string, afterId: number, limit: number, eventTypes?: string[]): Promise<SessionEventRow[]> {
    return this.interactive("event_read_page", [sessionId, afterId, limit, eventTypes]);
  }

  readOneEvent(sessionId: string, eventId: number): Promise<SessionEventDetailRow | null> {
    return this.interactive("event_read_one", [sessionId, eventId]);
  }

  streamEventsRaw(sessionId: string, afterId = 0): Promise<Array<{ id: number; event_type: string; payload_text: string }>> {
    return this.interactive("event_raw_page", [sessionId, afterId]);
  }

  searchEvents(query: string, sessionIds: string[] | null, limit: number, eventTypes?: string[] | null): Promise<SessionEventSearchRow[]> {
    return this.interactive("event_search", [query, sessionIds, limit, eventTypes]);
  }

  searchEventsBySessionId(query: string, eventTypes: string[] | null, limit: number): Promise<SessionEventSearchRow[]> {
    return this.interactive("event_session_id_search", [query, eventTypes, limit]);
  }

  async getSessionSearchMetadata(sessionIds: string[]): Promise<Map<string, SessionSearchMetadata>> {
    const entries = await this.interactive<Array<[string, SessionSearchMetadata]>>(
      "story_search_metadata",
      [sessionIds],
    );
    return new Map(entries);
  }

  countTurnSummaries(sessionId: string): Promise<SessionTurnSummaryCounts> {
    return this.background("turn_summary_count", [sessionId]);
  }

  loadTurnSummaryRange(sessionId: string, fromTurnNumber: number, toTurnNumber: number | null, limit: number): Promise<SessionStoryTurnSummary[]> {
    return this.background("turn_summary_range", [sessionId, fromTurnNumber, toTurnNumber, limit]);
  }

  searchSessionDigests(query: string, sessionIds: string[] | null, limit: number, includeHighlight: boolean, includeStory: boolean): Promise<SessionDigestSearchMatch[]> {
    return this.background("digest_search", [query, sessionIds, limit, includeHighlight, includeStory]);
  }

  getSessionStory(sessionId: string): Promise<SessionStoryView> {
    return this.background("story", [sessionId]);
  }

  getTurnExcerpt(sessionId: string, maxResponseChars = 500): Promise<SessionTurnExcerptResult> {
    return this.turnCritical("turn_excerpt", [sessionId, maxResponseChars]);
  }

  getResumeContext(sessionId: string, limit: number): Promise<SessionResumeContext> {
    return this.turnCritical("resume_context", [sessionId, limit]);
  }

  private interactive<T>(operation: string, args: unknown[]): Promise<T> {
    return this.request(operation, args, 5_000, 1);
  }

  private background<T>(operation: string, args: unknown[]): Promise<T> {
    return this.request(operation, args, 2_000, 2);
  }

  private turnCritical<T>(operation: string, args: unknown[]): Promise<T> {
    return this.request(operation, args, 1_500, 2);
  }

  private async request<T>(operation: string, args: unknown[], timeoutMs: number, attempts: number): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.transport.request<T>("session-data", operation, args, { timeoutMs });
      } catch (error) {
        lastError = error;
        if (!(error instanceof PersistenceHostRequestError) || !error.retryable || attempt === attempts) {
          break;
        }
      }
    }
    const retryable = lastError instanceof PersistenceHostRequestError && lastError.retryable;
    throw new SessionDataHostError({
      operation,
      retryable,
      message: `session-data host ${operation} failed`,
      cause: lastError,
    });
  }
}
