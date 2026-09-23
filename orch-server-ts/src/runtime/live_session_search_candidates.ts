import {
  compactSearchQuery,
  normalizeSearchQuery,
} from "@soulstream/search-contract";

import type { CogitoSearchParams } from "../cogito/cogito_routes.js";
import type { SessionSearchCandidateRow } from "../search/session_search_projection.js";
import type { SessionBackendCatalogEntry } from "./live_session_serialization.js";
import type {
  LiveSearchPendingQuery,
  LiveSearchSql,
} from "./live_db_sql.js";

export type QueryVariant = {
  readonly query: string;
  readonly kind: string;
};

export type CandidateQueryInput = {
  readonly sql: LiveSearchSql;
  readonly variants: readonly QueryVariant[];
  readonly params: CogitoSearchParams;
  readonly eventTypes: readonly string[];
  readonly candidateLimit: number;
  readonly activeQuery: {
    current?: LiveSearchPendingQuery<readonly Record<string, unknown>[]>;
  };
  readonly deadlineAt: number;
  readonly includeSessionMetadataSearch: boolean;
  readonly backendCatalog: readonly SessionBackendCatalogEntry[];
};

export async function loadCandidateRows(
  input: CandidateQueryInput,
): Promise<readonly SessionSearchCandidateRow[]> {
  const {
    sql,
    variants,
    params,
    eventTypes,
    candidateLimit,
    activeQuery,
    deadlineAt,
    includeSessionMetadataSearch,
    backendCatalog,
  } = input;
  const allowedFolderIds = params.allowedFolderIds ?? null;
  const sessionFilters = params.session_filters;
  const backendFilters = sessionFilters?.backends?.length ? sessionFilters.backends : null;
  const backendCatalogJson = JSON.stringify(backendCatalog);
  if (variants.length === 0) return [];
  return await runSearchQuery(activeQuery, () => sql`
    WITH query_variants AS (
      SELECT variant.query, variant.query_kind, variant.query_order
      FROM unnest(${variants.map((variant) => variant.query)}::text[],
                  ${variants.map((variant) => variant.kind)}::text[])
           WITH ORDINALITY AS variant(query, query_kind, query_order)
    ),
    raw_hits AS (
      SELECT
        query.query,
        query.query_kind,
        query.query_order,
        hit.id,
        hit.session_id,
        hit.event_type,
        hit.searchable_text,
        hit.created_at,
        hit.score,
        hit.match_source,
        hit.relevance_source
      FROM query_variants query
      CROSS JOIN LATERAL (
        SELECT
          event.id,
          event.session_id,
          event.event_type,
          event.searchable_text,
          event.created_at,
          event.score,
          CASE WHEN event.event_type = 'turn_summary'
            THEN 'turn_summary'::text ELSE 'message'::text END AS match_source,
          CASE
            WHEN event.event_type = 'turn_summary' THEN 'turn_summary'::text
            WHEN event.event_type = 'user_message' AND NOT EXISTS (
              SELECT 1 FROM events earlier_user
              WHERE earlier_user.session_id = event.session_id
                AND earlier_user.event_type = 'user_message'
                AND earlier_user.id < event.id
            ) THEN 'initial_request'::text
            WHEN event.event_type = 'user_message' THEN 'user_message'::text
            WHEN event.event_type = 'assistant_message' THEN 'assistant_message'::text
            ELSE 'message'::text
          END AS relevance_source
        FROM (
          SELECT * FROM event_search(
            query.query,
            NULL,
            ${candidateLimit},
            ${eventTypes}::text[],
            ${allowedFolderIds}::text[],
            NULL,
            0,
            ${sessionFilters?.node_id ?? null}::text,
            ${sessionFilters?.statuses?.length ? sessionFilters.statuses : null}::text[],
            ${sessionFilters?.updated_after ?? null}::timestamptz,
            ${backendFilters}::text[],
            ${backendCatalogJson}::text::jsonb
          )
        ) event
        UNION ALL
        SELECT
          session_match.id,
          session_match.session_id,
          session_match.event_type,
          session_match.searchable_text,
          session_match.created_at,
          session_match.score,
          'session_id'::text AS match_source,
          'session_id'::text AS relevance_source
        FROM session_id_search(
          query.query,
          ${eventTypes}::text[],
          ${candidateLimit},
          ${allowedFolderIds}::text[],
          ${sessionFilters?.node_id ?? null}::text,
          ${sessionFilters?.statuses?.length ? sessionFilters.statuses : null}::text[],
          ${sessionFilters?.updated_after ?? null}::timestamptz,
          ${backendFilters}::text[],
          ${backendCatalogJson}::text::jsonb
        ) session_match
        WHERE ${params.search_session_id}
        UNION ALL
        SELECT
          digest.narrative_through_event_id AS id,
          digest.session_id,
          matches.event_type,
          matches.searchable_text,
          digest.updated_at AS created_at,
          1.0 / matches.position AS score,
          matches.match_source,
          matches.match_source AS relevance_source
        FROM session_digests digest
        JOIN sessions digest_session ON digest_session.session_id = digest.session_id
        CROSS JOIN LATERAL (
          SELECT
            'session_highlight'::text AS event_type,
            digest.highlight AS searchable_text,
            STRPOS(LOWER(digest.highlight), LOWER(query.query)) AS position,
            'highlight'::text AS match_source
          WHERE ${params.include_highlight}
          UNION ALL
          SELECT
            'session_story'::text,
            digest.narrative,
            STRPOS(LOWER(digest.narrative), LOWER(query.query)),
            'story'::text
          WHERE ${params.include_story}
        ) matches
        WHERE matches.position > 0
          AND (${allowedFolderIds}::text[] IS NULL
            OR digest_session.folder_id = ANY(${allowedFolderIds}::text[]))
          AND (${sessionFilters?.node_id ?? null}::text IS NULL
            OR digest_session.node_id = ${sessionFilters?.node_id ?? null}::text)
          AND (${sessionFilters?.statuses?.length ? sessionFilters.statuses : null}::text[] IS NULL
            OR digest_session.status = ANY(${sessionFilters?.statuses?.length ? sessionFilters.statuses : null}::text[]))
          AND (${sessionFilters?.updated_after ?? null}::timestamptz IS NULL
            OR digest_session.updated_at >= ${sessionFilters?.updated_after ?? null}::timestamptz)
          AND (${backendFilters}::text[] IS NULL OR COALESCE(
            (SELECT mapping.value->>'backend'
             FROM jsonb_array_elements(${backendCatalogJson}::text::jsonb) AS mapping(value)
             WHERE mapping.value->>'kind' = 'preset'
               AND mapping.value->>'node_id' = digest_session.node_id
               AND mapping.value->>'model_preset' = digest_session.model_preset
             LIMIT 1),
            (SELECT mapping.value->>'backend'
             FROM jsonb_array_elements(${backendCatalogJson}::text::jsonb) AS mapping(value)
             WHERE mapping.value->>'kind' = 'agent'
               AND mapping.value->>'node_id' = digest_session.node_id
               AND mapping.value->>'agent_id' = digest_session.agent_id
             LIMIT 1)
          ) = ANY(${backendFilters}::text[]))
        ORDER BY score DESC, created_at DESC, session_id ASC
        LIMIT ${candidateLimit}
      ) hit
      UNION ALL
      SELECT
        query.query,
        query.query_kind,
        query.query_order,
        NULL::integer AS id,
        session.session_id,
        'session_metadata'::text AS event_type,
        CASE
          WHEN session.display_name_search_key LIKE session_search_compact(query.query) || '%'
            THEN coalesce(session.display_name, '')
          ELSE coalesce(session.prompt, '')
        END AS searchable_text,
        session.updated_at AS created_at,
        CASE
          WHEN session.display_name_search_key = session_search_compact(query.query)
            OR session.prompt_search_key = session_search_compact(query.query)
            THEN 2.0
          ELSE 1.0
        END::double precision AS score,
        CASE
          WHEN session.display_name_search_key LIKE session_search_compact(query.query) || '%'
            THEN 'title'::text
          ELSE 'prompt'::text
        END AS match_source,
        CASE
          WHEN session.display_name_search_key LIKE session_search_compact(query.query) || '%'
            THEN 'title'::text
          ELSE 'prompt'::text
        END AS relevance_source
      FROM query_variants query
      JOIN LATERAL (
        SELECT candidate.*
        FROM sessions candidate
        WHERE session_search_compact(query.query) <> ''
          AND (${allowedFolderIds}::text[] IS NULL
            OR candidate.folder_id = ANY(${allowedFolderIds}::text[]))
          AND (${sessionFilters?.node_id ?? null}::text IS NULL
            OR candidate.node_id = ${sessionFilters?.node_id ?? null}::text)
          AND (${sessionFilters?.statuses?.length ? sessionFilters.statuses : null}::text[] IS NULL
            OR candidate.status = ANY(${sessionFilters?.statuses?.length ? sessionFilters.statuses : null}::text[]))
          AND (${sessionFilters?.updated_after ?? null}::timestamptz IS NULL
            OR candidate.updated_at >= ${sessionFilters?.updated_after ?? null}::timestamptz)
          AND (${backendFilters}::text[] IS NULL OR COALESCE(
            (SELECT mapping.value->>'backend'
             FROM jsonb_array_elements(${backendCatalogJson}::text::jsonb) AS mapping(value)
             WHERE mapping.value->>'kind' = 'preset'
               AND mapping.value->>'node_id' = candidate.node_id
               AND mapping.value->>'model_preset' = candidate.model_preset
             LIMIT 1),
            (SELECT mapping.value->>'backend'
             FROM jsonb_array_elements(${backendCatalogJson}::text::jsonb) AS mapping(value)
             WHERE mapping.value->>'kind' = 'agent'
               AND mapping.value->>'node_id' = candidate.node_id
               AND mapping.value->>'agent_id' = candidate.agent_id
             LIMIT 1)
          ) = ANY(${backendFilters}::text[]))
          AND (candidate.display_name_search_key LIKE session_search_compact(query.query) || '%'
           OR candidate.prompt_search_key LIKE session_search_compact(query.query) || '%'
          )
        ORDER BY
          (candidate.display_name_search_key = session_search_compact(query.query)
           OR candidate.prompt_search_key = session_search_compact(query.query)) DESC,
          candidate.updated_at DESC NULLS LAST,
          candidate.session_id ASC
        LIMIT ${candidateLimit}
      ) session ON ${includeSessionMetadataSearch}
      UNION ALL
      SELECT
        query.query,
        'session_candidate_' || query.query_kind,
        query.query_order,
        candidate.id,
        candidate.session_id,
        candidate.event_type,
        candidate.searchable_text,
        candidate.created_at,
        candidate.score,
        CASE WHEN candidate.event_type = 'turn_summary'
          THEN 'turn_summary'::text ELSE 'message'::text END AS match_source,
        CASE
          WHEN candidate.event_type = 'turn_summary' THEN 'turn_summary'::text
          WHEN candidate.event_type = 'user_message' AND NOT EXISTS (
            SELECT 1 FROM events earlier_user
            WHERE earlier_user.session_id = candidate.session_id
              AND earlier_user.event_type = 'user_message'
              AND earlier_user.id < candidate.id
          ) THEN 'initial_request'::text
          WHEN candidate.event_type = 'user_message' THEN 'user_message'::text
          WHEN candidate.event_type = 'assistant_message' THEN 'assistant_message'::text
          ELSE 'message'::text
        END AS relevance_source
      FROM query_variants query
      CROSS JOIN LATERAL event_search(
        query.query,
        NULL,
        ${candidateLimit},
        ${eventTypes}::text[],
        ${params.allowedFolderIds ?? null}::text[],
        ${1},
        ${candidateLimit},
        ${sessionFilters?.node_id ?? null}::text,
        ${sessionFilters?.statuses?.length ? sessionFilters.statuses : null}::text[],
        ${sessionFilters?.updated_after ?? null}::timestamptz,
        ${backendFilters}::text[],
        ${backendCatalogJson}::text::jsonb
      ) candidate
      WHERE ${includeSessionMetadataSearch}
    )
    SELECT
      hit.query,
      hit.query_kind,
      hit.query_order,
      hit.id,
      hit.session_id,
      hit.event_type,
      hit.searchable_text,
      hit.created_at,
      hit.score,
      hit.match_source,
      hit.relevance_source,
      session.display_name,
      session.prompt AS session_prompt,
      (SELECT mapping.value->>'agent_name'
       FROM jsonb_array_elements(${backendCatalogJson}::text::jsonb) AS mapping(value)
       WHERE mapping.value->>'kind' = 'agent'
         AND mapping.value->>'node_id' = session.node_id
         AND mapping.value->>'agent_id' = session.agent_id
       LIMIT 1) AS agent_name,
      session.review_required,
      session.folder_id,
      session.node_id,
      session.status,
      COALESCE(
        (SELECT mapping.value->>'backend'
         FROM jsonb_array_elements(${backendCatalogJson}::text::jsonb) AS mapping(value)
         WHERE mapping.value->>'kind' = 'preset'
           AND mapping.value->>'node_id' = session.node_id
           AND mapping.value->>'model_preset' = session.model_preset
         LIMIT 1),
        (SELECT mapping.value->>'backend'
         FROM jsonb_array_elements(${backendCatalogJson}::text::jsonb) AS mapping(value)
         WHERE mapping.value->>'kind' = 'agent'
           AND mapping.value->>'node_id' = session.node_id
           AND mapping.value->>'agent_id' = session.agent_id
         LIMIT 1)
      ) AS backend,
      session.caller_session_id AS parent_session_id,
      session.updated_at AS session_updated_at,
      linked_task.id AS task_id,
      linked_task.title AS task_title,
      linked_task.task_evidence_kind,
      linked_task.task_evidence_title
    FROM raw_hits hit
    JOIN sessions session ON session.session_id = hit.session_id
    LEFT JOIN LATERAL (
      SELECT
        task.id,
        task.title,
        CASE
          WHEN task.completed_session_id = session.session_id THEN 'task_completed'
          WHEN completed_item.id IS NOT NULL THEN 'task_item_completed'
          WHEN primary_session_item.source_task_item_id IS NOT NULL THEN 'source_task_item'
          WHEN assigned_item.id IS NOT NULL THEN 'task_item_assigned'
          ELSE NULL
        END AS task_evidence_kind,
        CASE
          WHEN task.completed_session_id = session.session_id THEN task.title
          WHEN completed_item.id IS NOT NULL THEN completed_item.title
          WHEN primary_session_item.source_task_item_id IS NOT NULL THEN source_item.title
          WHEN assigned_item.id IS NOT NULL THEN assigned_item.title
          ELSE NULL
        END AS task_evidence_title
      FROM board_items primary_session_item
      JOIN tasks task ON task.id = primary_session_item.container_id
      JOIN board_items task_board_item ON task_board_item.id = task.board_item_id
      LEFT JOIN task_items source_item
        ON source_item.id = primary_session_item.source_task_item_id
       AND EXISTS (
         SELECT 1 FROM task_sections source_section
         WHERE source_section.id = source_item.section_id
           AND source_section.task_id = task.id
       )
      LEFT JOIN LATERAL (
        SELECT task_item.id, task_item.title
        FROM task_items task_item
        JOIN task_sections section ON section.id = task_item.section_id
        WHERE section.task_id = task.id
          AND section.archived = FALSE
          AND task_item.archived = FALSE
          AND task_item.completed_session_id = session.session_id
        ORDER BY task_item.completed_at DESC NULLS LAST, task_item.id
        LIMIT 1
      ) completed_item ON TRUE
      LEFT JOIN LATERAL (
        SELECT task_item.id, task_item.title
        FROM task_items task_item
        JOIN task_sections section ON section.id = task_item.section_id
        WHERE section.task_id = task.id
          AND section.archived = FALSE
          AND task_item.archived = FALSE
          AND task_item.assignee_session_id = session.session_id
        ORDER BY task_item.updated_at DESC, task_item.id
        LIMIT 1
      ) assigned_item ON TRUE
      WHERE primary_session_item.container_kind = 'task'
        AND primary_session_item.container_id = task.id
        AND primary_session_item.folder_id = session.folder_id
        AND primary_session_item.item_type = 'session'
        AND primary_session_item.item_id = session.session_id
        AND primary_session_item.membership_kind = 'primary'
        AND task.archived = FALSE
        AND task_board_item.folder_id = session.folder_id
        AND session.folder_id IS NOT NULL
      ORDER BY
        ((task.completed_session_id = session.session_id) IS TRUE) DESC,
        (completed_item.id IS NOT NULL) DESC,
        (primary_session_item.source_task_item_id IS NOT NULL) DESC,
        (assigned_item.id IS NOT NULL) DESC,
        task.id ASC
      LIMIT 1
    ) linked_task ON TRUE
    ORDER BY hit.query_order, hit.score DESC, hit.created_at DESC NULLS LAST,
             hit.session_id ASC, hit.id ASC NULLS LAST
  `, params.signal, deadlineAt, sql);
}

export async function runSearchQuery<T extends readonly Record<string, unknown>[]>(
  activeQuery: { current?: LiveSearchPendingQuery<T> },
  createQuery: () => LiveSearchPendingQuery<T>,
  signal: AbortSignal | undefined,
  deadlineAt: number,
  sql?: LiveSearchSql,
): Promise<T> {
  assertSearchMayContinue(signal, deadlineAt);
  try {
    if (sql?.setStatementTimeout !== undefined) {
      const timeoutMs = Math.min(
        3_000,
        Math.floor(deadlineAt - Date.now()) - 100,
      );
      if (timeoutMs < 1) {
        throw new SearchDeadlineError("search request deadline is too near for another database query");
      }
      await awaitSearchOperation(sql.setStatementTimeout(timeoutMs), signal);
      assertSearchMayContinue(signal, deadlineAt);
    }
    const query = createQuery();
    activeQuery.current = query;
    try {
      return await awaitSearchOperation(query, signal);
    } finally {
      if (activeQuery.current === query) activeQuery.current = undefined;
    }
  } catch (error) {
    if (!signal?.aborted && postgresStatementTimeout(error)) {
      throw new SearchDeadlineError("search database statement timed out");
    }
    throw error;
  }
}

function postgresStatementTimeout(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "57014";
}

async function awaitSearchOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return await operation;
  if (signal.aborted) throw new SearchDeadlineError("search request was cancelled");
  let rejectOnAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectOnAbort = reject; });
  const onAbort = () => rejectOnAbort(new SearchDeadlineError("search request was cancelled"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function buildQueryVariants(
  query: string,
  semanticQueries: readonly string[],
  includeNormalization: boolean,
): QueryVariant[] {
  const variants: QueryVariant[] = [{ query, kind: "original" }];
  if (!includeNormalization) return variants;
  const seen = new Set([query]);
  const normalized = normalizeSearchQuery(query);
  if (normalized && !seen.has(normalized)) {
    seen.add(normalized);
    variants.push({ query: normalized, kind: "normalized" });
  }
  const compact = compactSearchQuery(query);
  if (compact && !seen.has(compact)) {
    seen.add(compact);
    variants.push({ query: compact, kind: "compact" });
  }
  for (const [index, value] of semanticQueries.slice(0, 3).entries()) {
    const semantic = normalizeSearchQuery(value);
    if (!semantic || seen.has(semantic)) continue;
    seen.add(semantic);
    variants.push({ query: value.trim(), kind: `semantic_${index + 1}` });
  }
  return variants;
}

export function buildSemanticVariants(queries: readonly string[]): QueryVariant[] {
  const seen = new Set<string>();
  const variants: QueryVariant[] = [];
  for (const value of queries) {
    const normalized = normalizeSearchQuery(value);
    const query = value.trim();
    if (!normalized || seen.has(normalized) || variants.length >= 3) continue;
    seen.add(normalized);
    variants.push({ query, kind: `semantic_${variants.length + 1}` });
  }
  return variants;
}

export function assertSearchMayContinue(
  signal: AbortSignal | undefined,
  deadlineAt: number,
): void {
  if (signal?.aborted) throw new SearchDeadlineError("search request was cancelled");
  if (Date.now() >= deadlineAt) {
    throw new SearchDeadlineError("search request deadline exceeded");
  }
}

export class SearchDeadlineError extends Error {
  readonly statusCode = 504;
}

export function isSearchStopped(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted || error instanceof SearchDeadlineError;
}
