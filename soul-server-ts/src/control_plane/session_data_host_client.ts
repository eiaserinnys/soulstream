import type {
  ListSessionSummaryRow,
  RunningSessionSummaryRow,
  SessionExecutionChain,
  SessionOwnerNode,
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
import {
  requestHostOperationWithRetry,
  SESSION_START_RESTART_WINDOW,
  type RestartWindowRecoveryEvent,
  type RestartWindowRetryEvent,
  type RestartWindowRetryPolicy,
} from "./persistence_host_transport.js";
import type { GenerationCheckpointMaterial, GenerationCheckpointReadLimits, SessionReadPeriod } from "@soulstream/mcp-contract";

export const SESSION_DATA_READ_OPERATIONS = [
  "get",
  "list_summary",
  "list_running",
  "upstream_dump",
  "event_count",
  "event_read_page",
  "event_read_one",
  "event_raw_page",
  "event_search",
  "event_session_id_search",
  "history_search",
  "story_search_metadata",
  "turn_summary_count",
  "turn_summary_range",
  "digest_search",
  "story",
  "turn_excerpt",
  "resume_context",
  "generation_checkpoint_material",
  "caller_chain",
  "owner_node",
  "existing_session_ids",
] as const;

/** event_read_page의 id 정렬 방향. 생략하면 지금까지처럼 오름차순이다. */
export type SessionReadOrder = "asc" | "desc";

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

export interface SessionHistorySearchParams {
  query: string;
  sessionIds: string[] | null;
  limit: number;
  eventTypes: string[] | null;
  searchSessionId: boolean;
  includeHighlight: boolean;
  includeStory: boolean;
}

export interface SessionHistorySearchResult {
  events: SessionEventSearchRow[];
  sessionIdEvents: SessionEventSearchRow[];
  digests: SessionDigestSearchMatch[];
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

/** Per-call switches for session reads. */
export interface SessionReadOptions {
  /**
   * Apply the session-start restart-window schedule. Only reads whose failure
   * refuses a session start pass this (card #1350); every other getSession
   * keeps the turn-critical budget.
   */
  restartWindow?: boolean;
}

export interface SessionDataHost {
  listExistingSessionIds(sessionIds: string[]): Promise<string[]>;
  getSession(sessionId: string, options?: SessionReadOptions): Promise<SessionRow | null>;
  listSessionsSummary(params: {
    search?: string | null;
    limit: number;
    offset: number;
    folderId?: string | null;
    nodeId?: string | null;
    period?: SessionReadPeriod;
  }): Promise<{ sessions: ListSessionSummaryRow[]; total: number }>;
  listRunningSessionsSummary(params: {
    limit: number;
    excludeSessionId?: string | null;
  }): Promise<{ sessions: RunningSessionSummaryRow[]; total: number }>;
  listSessionsForUpstreamDump(params: {
    limit: number;
    offset: number;
    nodeId: string;
  }): Promise<{ sessions: UpstreamSessionDumpRow[]; total: number }>;
  countEvents(sessionId: string): Promise<number>;
  readEvents(sessionId: string, afterId: number, limit: number, eventTypes?: string[], period?: SessionReadPeriod, metadataTypes?: string[], order?: SessionReadOrder): Promise<SessionEventRow[]>;
  readOneEvent(sessionId: string, eventId: number): Promise<SessionEventDetailRow | null>;
  streamEventsRaw(sessionId: string, afterId?: number): Promise<Array<{ id: number; event_type: string; payload_text: string }>>;
  searchEvents(query: string, sessionIds: string[] | null, limit: number, eventTypes?: string[] | null, signal?: AbortSignal): Promise<SessionEventSearchRow[]>;
  searchEventsBySessionId(query: string, eventTypes: string[] | null, limit: number, signal?: AbortSignal): Promise<SessionEventSearchRow[]>;
  searchSessionHistory(params: SessionHistorySearchParams, signal?: AbortSignal): Promise<SessionHistorySearchResult>;
  getSessionSearchMetadata(sessionIds: string[]): Promise<Map<string, SessionSearchMetadata>>;
  countTurnSummaries(sessionId: string): Promise<SessionTurnSummaryCounts>;
  loadTurnSummaryRange(sessionId: string, fromTurnNumber: number, toTurnNumber: number | null, limit: number, period?: SessionReadPeriod): Promise<SessionStoryTurnSummary[]>;
  searchSessionDigests(query: string, sessionIds: string[] | null, limit: number, includeHighlight: boolean, includeStory: boolean, signal?: AbortSignal): Promise<SessionDigestSearchMatch[]>;
  getSessionStory(sessionId: string): Promise<SessionStoryView>;
  getTurnExcerpt(sessionId: string, maxResponseChars?: number): Promise<SessionTurnExcerptResult>;
  getResumeContext(sessionId: string, limit: number): Promise<SessionResumeContext>;
  getGenerationCheckpointMaterial(
    sessionId: string,
    limits: GenerationCheckpointReadLimits,
  ): Promise<GenerationCheckpointMaterial>;
  getSessionCallerChain(sessionId: string): Promise<SessionExecutionChain>;
  getSessionOwnerNode(sessionId: string): Promise<SessionOwnerNode | null>;
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
  async listExistingSessionIds(sessionIds: string[]): Promise<string[]> {
    const existing: string[] = [];
    for (let offset = 0; offset < sessionIds.length; offset += 500) {
      existing.push(...await this.turnCritical<string[]>("existing_session_ids", [sessionIds.slice(offset, offset + 500)]));
    }
    return existing;
  }
  private readonly transport: PersistenceHostTransport;
  private readonly logger: HostClientConfig["logger"];

  constructor(config: HostClientConfig) {
    this.transport = new PersistenceHostTransport(config);
    this.logger = config.logger;
  }

  /**
   * Lazy task hydration reads the evicted session row while starting a
   * session; task_manager wraps a failure into IsolationPolicyUnavailableError
   * and refuses the start. That call site opts into the restart-window
   * schedule; every other getSession keeps the turn-critical budget.
   */
  getSession(sessionId: string, options?: SessionReadOptions): Promise<SessionRow | null> {
    if (options?.restartWindow === true) {
      return this.restartWindowRead("evicted_session", "get", [sessionId], {
        timeoutMs: 1_500,
        attempts: 2,
      });
    }
    return this.turnCritical("get", [sessionId]);
  }

  listSessionsSummary(params: Parameters<SessionDataHost["listSessionsSummary"]>[0]): ReturnType<SessionDataHost["listSessionsSummary"]> {
    return this.interactive("list_summary", [params]);
  }

  listRunningSessionsSummary(params: Parameters<SessionDataHost["listRunningSessionsSummary"]>[0]): ReturnType<SessionDataHost["listRunningSessionsSummary"]> {
    return this.turnCritical("list_running", [params]);
  }

  listSessionsForUpstreamDump(params: Parameters<SessionDataHost["listSessionsForUpstreamDump"]>[0]): ReturnType<SessionDataHost["listSessionsForUpstreamDump"]> {
    return this.interactive("upstream_dump", [params]);
  }

  countEvents(sessionId: string): Promise<number> {
    return this.interactive("event_count", [sessionId]);
  }

  /**
   * Input preparation reads the original request from the session timeline
   * (card #1604). It must outlast an orchestrator restart like the other
   * session-start reads instead of failing the turn with
   * INPUT_PREPARATION_FAILED; a busy host still costs latency, not the turn.
   */
  readEvents(sessionId: string, afterId: number, limit: number, eventTypes?: string[], period?: SessionReadPeriod, metadataTypes?: string[], order?: SessionReadOrder): Promise<SessionEventRow[]> {
    const args: unknown[] = [sessionId, afterId, limit, eventTypes];
    if (order === "desc") {
      args.push(period ?? null, metadataTypes ?? null, "desc");
    } else if (metadataTypes !== undefined) {
      args.push(period ?? null, metadataTypes);
    } else if (period !== undefined) {
      args.push(period);
    }
    return this.restartWindowRead("session_events", "event_read_page", args, {
      timeoutMs: 5_000,
      attempts: 1,
      attemptTimeoutMs: 5_000,
    });
  }

  readOneEvent(sessionId: string, eventId: number): Promise<SessionEventDetailRow | null> {
    return this.interactive("event_read_one", [sessionId, eventId]);
  }

  streamEventsRaw(sessionId: string, afterId = 0): Promise<Array<{ id: number; event_type: string; payload_text: string }>> {
    return this.interactive("event_raw_page", [sessionId, afterId]);
  }

  searchEvents(query: string, sessionIds: string[] | null, limit: number, eventTypes?: string[] | null, signal?: AbortSignal): Promise<SessionEventSearchRow[]> {
    return this.interactive("event_search", [query, sessionIds, limit, eventTypes], signal);
  }

  searchEventsBySessionId(query: string, eventTypes: string[] | null, limit: number, signal?: AbortSignal): Promise<SessionEventSearchRow[]> {
    return this.interactive("event_session_id_search", [query, eventTypes, limit], signal);
  }

  searchSessionHistory(params: SessionHistorySearchParams, signal?: AbortSignal): Promise<SessionHistorySearchResult> {
    return this.interactive("history_search", [params], signal);
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

  loadTurnSummaryRange(sessionId: string, fromTurnNumber: number, toTurnNumber: number | null, limit: number, period?: SessionReadPeriod): Promise<SessionStoryTurnSummary[]> {
    const args: unknown[] = [sessionId, fromTurnNumber, toTurnNumber, limit];
    if (period !== undefined) args.push({ period });
    return this.background("turn_summary_range", args);
  }

  searchSessionDigests(query: string, sessionIds: string[] | null, limit: number, includeHighlight: boolean, includeStory: boolean, signal?: AbortSignal): Promise<SessionDigestSearchMatch[]> {
    const args = [query, sessionIds, limit, includeHighlight, includeStory];
    return signal === undefined
      ? this.background("digest_search", args)
      : this.interactive("digest_search", args, signal);
  }

  /**
   * Predecessor history is part of input preparation (card #1604): a
   * restarting host must widen instead of ending the session before its first
   * response. The read keeps its 2s attempt budget and two-attempt schedule.
   */
  getSessionStory(sessionId: string): Promise<SessionStoryView> {
    return this.restartWindowRead("session_story", "story", [sessionId], {
      timeoutMs: 2_000,
      attempts: 2,
      attemptTimeoutMs: 2_000,
    });
  }

  getTurnExcerpt(sessionId: string, maxResponseChars = 500): Promise<SessionTurnExcerptResult> {
    return this.turnCritical("turn_excerpt", [sessionId, maxResponseChars]);
  }

  getResumeContext(sessionId: string, limit: number): Promise<SessionResumeContext> {
    return this.turnCritical("resume_context", [sessionId, limit]);
  }

  /**
   * The composite material runs once at generation rollover, which is input
   * preparation (card #1604). It keeps its 5s × 2 schedule and widens across an
   * orchestrator restart.
   */
  getGenerationCheckpointMaterial(
    sessionId: string,
    limits: GenerationCheckpointReadLimits,
  ): Promise<GenerationCheckpointMaterial> {
    return this.restartWindowRead(
      "generation_checkpoint",
      "generation_checkpoint_material",
      [sessionId, limits],
      { timeoutMs: 5_000, attempts: 2, attemptTimeoutMs: 5_000 },
    );
  }

  getSessionCallerChain(sessionId: string): Promise<SessionExecutionChain> {
    return this.securityGate("caller_chain", [sessionId]);
  }

  getSessionOwnerNode(sessionId: string): Promise<SessionOwnerNode | null> {
    return this.turnCritical("owner_node", [sessionId]);
  }

  private interactive<T>(operation: string, args: unknown[], signal?: AbortSignal): Promise<T> {
    return this.request(operation, args, 5_000, 1, signal);
  }

  private background<T>(operation: string, args: unknown[]): Promise<T> {
    return this.request(operation, args, 2_000, 2);
  }

  /**
   * Reads on the turn path. The host queue can stall for several seconds
   * (p99.9 ~10s, max ~29s in the 48h sample of card #1380), so a 1.5s attempt
   * turned a busy host into a failed read. Each attempt gets 8s and the second
   * starts 500ms after the first fails; a stall longer than that still fails.
   */
  private turnCritical<T>(operation: string, args: unknown[]): Promise<T> {
    return this.request(operation, args, 8_000, 2, undefined, [500]);
  }

  /**
   * The isolation gate refuses the turn when this read fails, so a busy host
   * must cost latency, not the turn. The query itself answers in milliseconds;
   * at load ~20 the host queue alone took 2-5s and the turn-critical 1.5s x 2
   * budget refused a trusted top-level session (card #1111).
   */
  private securityGate<T>(operation: string, args: unknown[]): Promise<T> {
    return this.restartWindowRead("caller_chain", operation, args, {
      timeoutMs: 5_000,
      attempts: 3,
      retryDelaysMs: [250, 1_000],
    });
  }

  /**
   * A read a session start cannot do without (card #1350) outlasts an
   * orchestrator restart: refused connections and 502/503/504 widen up to
   * 90s, while timeouts keep the caller's attempt count. Each attempt gets the
   * policy's 8s. `read` names the call site in both retry logs.
   */
  private restartWindowRead<T>(
    read: string,
    operation: string,
    args: unknown[],
    base: {
      timeoutMs: number;
      attempts: number;
      retryDelaysMs?: readonly number[];
      /**
       * Per-attempt limit to keep for this read. The restart-window policy's
       * own attempt timeout replaces the caller's plain timeout, but a read
       * that already had a deliberate attempt budget keeps it.
       */
      attemptTimeoutMs?: number;
    },
  ): Promise<T> {
    const restartWindow: RestartWindowRetryPolicy = {
      ...SESSION_START_RESTART_WINDOW,
      ...(base.attemptTimeoutMs === undefined
        ? {}
        : { attemptTimeoutMs: base.attemptTimeoutMs }),
      onRetry: (event: RestartWindowRetryEvent) => {
        this.logger.warn(
          { read, operation, ...event },
          "session-start read retrying while the host restarts",
        );
      },
      onRecovered: (event: RestartWindowRecoveryEvent) => {
        this.logger.info(
          { read, operation, ...event },
          "session-start read recovered after a host restart",
        );
      },
    };
    return this.request<T>(
      operation,
      args,
      base.timeoutMs,
      base.attempts,
      undefined,
      base.retryDelaysMs ?? [],
      restartWindow,
    );
  }

  private async request<T>(
    operation: string,
    args: unknown[],
    timeoutMs: number,
    attempts: number,
    signal?: AbortSignal,
    retryDelaysMs: readonly number[] = [],
    restartWindow?: RestartWindowRetryPolicy,
  ): Promise<T> {
    try {
      return await requestHostOperationWithRetry<T>(
        this.transport,
        "session-data",
        operation,
        args,
        { timeoutMs, attempts, signal, retryDelaysMs, restartWindow },
      );
    } catch (lastError) {
      const retryable = lastError instanceof PersistenceHostRequestError && lastError.retryable;
      throw new SessionDataHostError({
        operation,
        retryable,
        message: `session-data host ${operation} failed`,
        cause: lastError,
      });
    }
  }
}
