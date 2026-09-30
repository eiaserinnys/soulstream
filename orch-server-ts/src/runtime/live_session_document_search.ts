import type { CogitoSearchParams } from "../cogito/cogito_routes.js";
import {
  chooseSessionSummary,
  SessionDocumentSearchIndex,
  type SessionDocumentRecord,
  type SessionDocumentRosterRow,
  type SessionSummaryEvent,
} from "../search/session_document_search_index.js";
import type { SessionBackendCatalogEntry } from "./live_session_serialization.js";
import {
  assertSearchMayContinue,
  runSearchQuery,
} from "./live_session_search_candidates.js";
import type {
  LiveSearchPendingQuery,
  LiveSearchSql,
} from "./live_db_sql.js";

type ActiveQuery = { current?: LiveSearchPendingQuery<readonly Record<string, unknown>[]> };
type SessionSourceRow = Omit<SessionDocumentRecord, "summary">;
type SessionDigestRow = { readonly session_id: string; readonly highlight: string | null };
type SessionSummarySourceRow = SessionSummaryEvent & { readonly session_id: string };

export class LiveSessionDocumentSearch {
  readonly index = new SessionDocumentSearchIndex();
  private initialized = false;
  private watermarkMs = 0;
  private refreshPromise: Promise<number> | undefined;

  refresh(input: {
    readonly sql: LiveSearchSql;
    readonly activeQuery: ActiveQuery;
    readonly deadlineAt: number;
    readonly signal: AbortSignal;
  }): Promise<number> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refreshInternal(input).finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }

  private async refreshInternal(input: {
    readonly sql: LiveSearchSql;
    readonly activeQuery: ActiveQuery;
    readonly deadlineAt: number;
    readonly signal: AbortSignal;
  }): Promise<number> {
    const startedAt = Date.now();
    assertSearchMayContinue(input.signal, input.deadlineAt);
    if (!this.initialized) {
      const sessions = await runSearchQuery(input.activeQuery, () => input.sql`
        SELECT
          session_id,
          display_name,
          left(prompt, 2000) AS prompt,
          left(last_assistant_text, 400) AS last_assistant_text,
          created_at,
          agent_id
        FROM sessions
        WHERE COALESCE(session_type, '') <> 'llm'
      `, input.signal, input.deadlineAt, input.sql, input.deadlineAt - Date.now()) as readonly SessionSourceRow[];
      const digests = await runSearchQuery(input.activeQuery, () => input.sql`
        SELECT session_id, left(highlight, 1500) AS highlight
        FROM session_digests
      `, input.signal, input.deadlineAt, input.sql, input.deadlineAt - Date.now()) as readonly SessionDigestRow[];
      const events = await runSearchQuery(input.activeQuery, () => input.sql`
        SELECT
          session_id,
          id AS event_id,
          left(payload->>'content', 1500) AS content
        FROM events
        WHERE event_type = 'turn_summary'
        ORDER BY session_id, id
      `, input.signal, input.deadlineAt, input.sql, input.deadlineAt - Date.now()) as readonly SessionSummarySourceRow[];
      this.index.initialize(assembleSessionDocumentRecords(sessions, digests, events));
      this.initialized = true;
      this.watermarkMs = startedAt;
      return Math.max(0, Date.now() - startedAt);
    }

    const roster = await runSearchQuery(input.activeQuery, () => input.sql`
      SELECT session_id, display_name
      FROM sessions
      WHERE COALESCE(session_type, '') <> 'llm'
    `, input.signal, input.deadlineAt, input.sql, input.deadlineAt - Date.now()) as readonly SessionDocumentRosterRow[];
    const { refreshSessionIds, deletedSessionIds } = this.index.findRosterChanges(roster);
    const overlap = new Date(this.watermarkMs - 5_000).toISOString();
    const timestampChanges = await runSearchQuery(input.activeQuery, () => input.sql`
      SELECT session_id
      FROM sessions
      WHERE COALESCE(session_type, '') <> 'llm'
        AND created_at >= ${overlap}::timestamptz
      UNION
      SELECT session_id
      FROM sessions
      WHERE COALESCE(session_type, '') <> 'llm'
        AND sessions.updated_at >= ${overlap}::timestamptz
      UNION
      SELECT session_id
      FROM session_digests
      WHERE updated_at >= ${overlap}::timestamptz
      UNION
      SELECT DISTINCT session_id
      FROM events
      WHERE event_type = 'turn_summary'
        AND created_at >= ${overlap}::timestamptz
    `, input.signal, input.deadlineAt, input.sql, input.deadlineAt - Date.now()) as readonly { readonly session_id: string }[];
    const liveSessionIds = new Set(roster.map((row) => row.session_id));
    const refreshIds = [...new Set([
      ...refreshSessionIds,
      ...timestampChanges.map((row) => row.session_id),
    ])].filter((sessionId) => liveSessionIds.has(sessionId)).sort();

    if (refreshIds.length > 0) {
      const sessions = await runSearchQuery(input.activeQuery, () => input.sql`
        SELECT
          session_id,
          display_name,
          left(prompt, 2000) AS prompt,
          left(last_assistant_text, 400) AS last_assistant_text,
          created_at,
          agent_id
        FROM sessions
        WHERE session_id = ANY(${refreshIds}::text[])
          AND COALESCE(session_type, '') <> 'llm'
      `, input.signal, input.deadlineAt, input.sql, input.deadlineAt - Date.now()) as readonly SessionSourceRow[];
      const digests = await runSearchQuery(input.activeQuery, () => input.sql`
        SELECT session_id, left(highlight, 1500) AS highlight
        FROM session_digests
        WHERE session_id = ANY(${refreshIds}::text[])
      `, input.signal, input.deadlineAt, input.sql, input.deadlineAt - Date.now()) as readonly SessionDigestRow[];
      const events = await runSearchQuery(input.activeQuery, () => input.sql`
        SELECT
          session_id,
          id AS event_id,
          left(payload->>'content', 1500) AS content
        FROM events
        WHERE session_id = ANY(${refreshIds}::text[])
          AND event_type = 'turn_summary'
        ORDER BY session_id, id
      `, input.signal, input.deadlineAt, input.sql, input.deadlineAt - Date.now()) as readonly SessionSummarySourceRow[];
      this.index.applyRefresh(
        assembleSessionDocumentRecords(sessions, digests, events),
        deletedSessionIds,
      );
    } else {
      this.index.applyRefresh([], deletedSessionIds);
    }
    this.watermarkMs = startedAt;
    return Math.max(0, Date.now() - startedAt);
  }
}

function assembleSessionDocumentRecords(
  sessions: readonly SessionSourceRow[],
  digests: readonly SessionDigestRow[],
  events: readonly SessionSummarySourceRow[],
): SessionDocumentRecord[] {
  const highlights = new Map(digests.map((row) => [row.session_id, row.highlight]));
  const summaries = new Map<string, SessionSummaryEvent[]>();
  for (const event of events) {
    const sessionEvents = summaries.get(event.session_id) ?? [];
    sessionEvents.push({ event_id: event.event_id, content: event.content });
    summaries.set(event.session_id, sessionEvents);
  }
  return sessions.map((session) => {
    const summary = chooseSessionSummary(
      highlights.get(session.session_id) ?? null,
      summaries.get(session.session_id) ?? [],
    );
    return { ...session, summary };
  });
}

export type SessionDocumentCandidateRow = Record<string, unknown> & { readonly session_id: string };

export async function loadSessionDocumentCandidateRows(input: {
  readonly sql: LiveSearchSql;
  readonly sessionIds: readonly string[];
  readonly params: CogitoSearchParams;
  readonly activeQuery: ActiveQuery;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly backendCatalog: readonly SessionBackendCatalogEntry[];
  readonly limit: number;
}): Promise<readonly SessionDocumentCandidateRow[]> {
  if (input.sessionIds.length === 0) return [];
  const filters = input.params.session_filters;
  const allowedFolders = input.params.allowedFolderIds ?? null;
  const statuses = filters?.statuses?.length ? filters.statuses : null;
  const backends = filters?.backends?.length ? filters.backends : null;
  const backendCatalog = JSON.stringify(input.backendCatalog);
  return await runSearchQuery(input.activeQuery, () => input.sql`
    WITH requested AS (
      SELECT session_id, ordinality
      FROM unnest(${input.sessionIds}::text[]) WITH ORDINALITY AS ids(session_id, ordinality)
    )
    SELECT
      session.session_id,
      session.display_name,
      session.prompt AS session_prompt,
      session.review_required,
      session.folder_id,
      session.node_id,
      session.status,
      COALESCE(
        (SELECT mapping.value->>'backend'
         FROM jsonb_array_elements(${backendCatalog}::text::jsonb) AS mapping(value)
         WHERE mapping.value->>'kind' = 'preset'
           AND mapping.value->>'node_id' = session.node_id
           AND mapping.value->>'model_preset' = session.model_preset
         LIMIT 1),
        (SELECT mapping.value->>'backend'
         FROM jsonb_array_elements(${backendCatalog}::text::jsonb) AS mapping(value)
         WHERE mapping.value->>'kind' = 'agent'
           AND mapping.value->>'node_id' = session.node_id
           AND mapping.value->>'agent_id' = session.agent_id
         LIMIT 1)
      ) AS backend,
      (SELECT mapping.value->>'agent_name'
       FROM jsonb_array_elements(${backendCatalog}::text::jsonb) AS mapping(value)
       WHERE mapping.value->>'kind' = 'agent'
         AND mapping.value->>'node_id' = session.node_id
         AND mapping.value->>'agent_id' = session.agent_id
       LIMIT 1) AS agent_name,
      session.caller_session_id AS parent_session_id,
      session.created_at AS session_created_at,
      session.updated_at AS session_updated_at,
      folder_evidence.name AS folder_name,
      folder_evidence.folder_evidence_kind,
      folder_evidence.folder_evidence_title
    FROM requested
    JOIN sessions session ON session.session_id = requested.session_id
    LEFT JOIN LATERAL (
      SELECT
        linked_folder.id,
        linked_folder.name,
        CASE
          WHEN linked_folder.completed_session_id = session.session_id THEN 'folder_completed'
          WHEN completed_item.id IS NOT NULL THEN 'card_completed'
          WHEN source_item.id IS NOT NULL THEN 'source_card'
          WHEN assigned_item.id IS NOT NULL THEN 'card_assigned'
          ELSE NULL
        END AS folder_evidence_kind,
        CASE
          WHEN linked_folder.completed_session_id = session.session_id THEN linked_folder.name
          WHEN completed_item.id IS NOT NULL THEN completed_item.title
          WHEN source_item.id IS NOT NULL THEN source_item.title
          WHEN assigned_item.id IS NOT NULL THEN assigned_item.title
          ELSE NULL
        END AS folder_evidence_title
      FROM board_items primary_session_item
      JOIN folders linked_folder ON linked_folder.id = primary_session_item.folder_id
      LEFT JOIN cards source_item
        ON source_item.id = session.card_id AND source_item.folder_id = linked_folder.id
      LEFT JOIN LATERAL (
        SELECT card.id, card.title
        FROM cards card
        WHERE card.folder_id = linked_folder.id
          AND card.archived = FALSE
          AND card.completed_session_id = session.session_id
        ORDER BY card.completed_at DESC NULLS LAST, card.id
        LIMIT 1
      ) completed_item ON TRUE
      LEFT JOIN LATERAL (
        SELECT card.id, card.title
        FROM cards card
        WHERE card.folder_id = linked_folder.id
          AND card.archived = FALSE
          AND card.assignee_session_id = session.session_id
        ORDER BY card.updated_at DESC, card.id
        LIMIT 1
      ) assigned_item ON TRUE
      WHERE primary_session_item.folder_id = linked_folder.id
        AND primary_session_item.folder_id = session.folder_id
        AND primary_session_item.item_type = 'session'
        AND primary_session_item.item_id = session.session_id
        AND primary_session_item.membership_kind = 'primary'
        AND linked_folder.archived = FALSE
        AND session.folder_id IS NOT NULL
      ORDER BY
        ((linked_folder.completed_session_id = session.session_id) IS TRUE) DESC,
        (completed_item.id IS NOT NULL) DESC,
        (source_item.id IS NOT NULL) DESC,
        (assigned_item.id IS NOT NULL) DESC,
        linked_folder.id ASC
      LIMIT 1
    ) folder_evidence ON TRUE
    WHERE COALESCE(session.session_type, '') <> 'llm'
      AND (${allowedFolders}::text[] IS NULL OR session.folder_id = ANY(${allowedFolders}::text[]))
      AND (${filters?.node_id ?? null}::text IS NULL OR session.node_id = ${filters?.node_id ?? null}::text)
      AND (${statuses}::text[] IS NULL OR session.status = ANY(${statuses}::text[]))
      AND (${filters?.updated_after ?? null}::timestamptz IS NULL
        OR session.updated_at >= ${filters?.updated_after ?? null}::timestamptz)
      AND (${backends}::text[] IS NULL OR COALESCE(
        (SELECT mapping.value->>'backend'
         FROM jsonb_array_elements(${backendCatalog}::text::jsonb) AS mapping(value)
         WHERE mapping.value->>'kind' = 'preset'
           AND mapping.value->>'node_id' = session.node_id
           AND mapping.value->>'model_preset' = session.model_preset
         LIMIT 1),
        (SELECT mapping.value->>'backend'
         FROM jsonb_array_elements(${backendCatalog}::text::jsonb) AS mapping(value)
         WHERE mapping.value->>'kind' = 'agent'
           AND mapping.value->>'node_id' = session.node_id
           AND mapping.value->>'agent_id' = session.agent_id
         LIMIT 1)
      ) = ANY(${backends}::text[]))
    ORDER BY requested.ordinality
    LIMIT ${input.limit}
  `, input.signal, input.deadlineAt, input.sql) as readonly SessionDocumentCandidateRow[];
}
