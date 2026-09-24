import { compactSearchQuery } from "@soulstream/search-contract";

import type { CogitoSearchParams } from "../cogito/cogito_routes.js";
import type { SessionSearchCandidateRow } from "../search/session_search_projection.js";
import {
  assertSearchMayContinue,
  runSearchQuery,
  SearchDeadlineError,
  type QueryVariant,
} from "./live_session_search_candidates.js";
import type { SessionBackendCatalogEntry } from "./live_session_serialization.js";
import type {
  LiveSearchPendingQuery,
  LiveSearchSql,
} from "./live_db_sql.js";

export type SessionMetadataCandidateResult = {
  readonly rows: readonly SessionSearchCandidateRow[];
  readonly status: "complete" | "partial";
  readonly reason?: "timeout" | "cancelled" | "error";
};

export type SessionMetadataCandidateInput = {
  readonly sql: LiveSearchSql;
  readonly variants: readonly QueryVariant[];
  readonly params: CogitoSearchParams;
  readonly candidateLimit: number;
  readonly activeQuery: {
    current?: LiveSearchPendingQuery<readonly Record<string, unknown>[]>;
  };
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly backendCatalog: readonly SessionBackendCatalogEntry[];
};

export async function loadSessionMetadataCandidateRows(
  input: SessionMetadataCandidateInput,
): Promise<SessionMetadataCandidateResult> {
  const { sql, variants, params, candidateLimit, activeQuery, deadlineAt, signal } = input;
  if (variants.length === 0) return { rows: [], status: "complete" };

  const allowedFolderIds = params.allowedFolderIds ?? null;
  const sessionFilters = params.session_filters;
  const backends = sessionFilters?.backends?.length ? sessionFilters.backends : null;
  const createGroup = () => {
    const values: unknown[] = [];
    const bind = (value: unknown, type: string): string => {
      values.push(value);
      return `$${values.length}::${type}`;
    };
    return {
      branches: [] as string[],
      values,
      bind,
      allowedFolders: bind(allowedFolderIds, "text[]"),
      nodeId: bind(sessionFilters?.node_id ?? null, "text"),
      statuses: bind(sessionFilters?.statuses?.length ? sessionFilters.statuses : null, "text[]"),
      updatedAfter: bind(sessionFilters?.updated_after ?? null, "timestamptz"),
      backendFilter: bind(backends, "text[]"),
      backendCatalog: bind(input.backendCatalog, "jsonb"),
      limit: bind(candidateLimit, "integer"),
    };
  };

  const titlePrefix = createGroup();
  const promptPrefix = createGroup();
  const titleTokens = createGroup();
  const promptTokens = createGroup();
  const allowTokenCandidates = Array.from(params.q).length <= 128;

  variants.forEach((variant, index) => {
    const compactVariant = compactSearchQuery(variant.query);
    if (!compactVariant || !/[\p{L}\p{N}]/u.test(variant.query)) return;
    for (const source of [
      { key: "display_name_search_key", text: "display_name", kind: "title" },
      { key: "prompt_search_key", text: "prompt", kind: "prompt" },
    ] as const) {
      const prefixGroup = source.kind === "title" ? titlePrefix : promptPrefix;
      const query = prefixGroup.bind(variant.query, "text");
      const queryKind = prefixGroup.bind(variant.kind, "text");
      const queryOrder = prefixGroup.bind(index + 1, "integer");
      // PostgreSQL's POSIX punctuation class is the canonical search-key normalizer.
      // It removes some Unicode symbols that the JS \\p{P} normalizer preserves.
      const compactQuery = `session_search_compact(${query})`;
      const prefixBackend = sessionBackendExpression("candidate", prefixGroup.backendCatalog);
      prefixGroup.branches.push(`
        SELECT * FROM (
          SELECT
            ${query} AS query,
            ${queryKind} AS query_kind,
            ${queryOrder} AS query_order,
            NULL::integer AS id,
            candidate.session_id,
            'session_metadata'::text AS event_type,
            COALESCE(candidate.${source.text}, '') AS searchable_text,
            candidate.updated_at AS created_at,
            CASE WHEN candidate.${source.key} = ${compactQuery} THEN 2.0
                 ELSE 1.0 END::double precision AS score,
            '${source.kind}'::text AS match_source,
            '${source.kind}'::text AS relevance_source
          FROM sessions candidate
          WHERE ${compactQuery} <> ''
            AND (${prefixGroup.allowedFolders} IS NULL OR candidate.folder_id = ANY(${prefixGroup.allowedFolders}))
            AND (${prefixGroup.nodeId} IS NULL OR candidate.node_id = ${prefixGroup.nodeId})
            AND (${prefixGroup.statuses} IS NULL OR candidate.status = ANY(${prefixGroup.statuses}))
            AND (${prefixGroup.updatedAfter} IS NULL OR candidate.updated_at >= ${prefixGroup.updatedAfter})
            AND (${prefixGroup.backendFilter} IS NULL OR ${prefixBackend} = ANY(${prefixGroup.backendFilter}))
            AND session_search_index_prefix(candidate.${source.key})
                LIKE session_search_index_prefix(${compactQuery}) || '%'
            AND candidate.${source.key} LIKE ${compactQuery} || '%'
          ORDER BY (candidate.${source.key} = ${compactQuery}) DESC,
                   candidate.updated_at DESC NULLS LAST,
                   candidate.session_id ASC
          LIMIT ${prefixGroup.limit}
        ) source_candidates
      `);
      // Token overlap is for concise human search phrases. Long inputs retain
      // exact/prefix metadata and the existing mode-specific body-search path.
      if (allowTokenCandidates && Array.from(variant.query).length <= 128) {
        const tokenGroup = source.kind === "title" ? titleTokens : promptTokens;
        const tokenQuery = tokenGroup.bind(variant.query, "text");
        const tokenKind = tokenGroup.bind(variant.kind, "text");
        const tokenOrder = tokenGroup.bind(index + 1, "integer");
        const tokenBackend = sessionBackendExpression("candidate", tokenGroup.backendCatalog);
        const queryTerms = `session_search_tokens(${tokenQuery})`;
        const candidateTerms = `session_search_tokens(candidate.${source.text})`;
        const overlappingTerms = `(
          SELECT COUNT(*)::double precision
          FROM unnest(${queryTerms}) AS query_term(term)
          WHERE query_term.term = ANY(${candidateTerms})
        )`;
        const termCoverage = `(${overlappingTerms} / NULLIF(cardinality(${queryTerms}), 0))`;
        tokenGroup.branches.push(`
          SELECT * FROM (
            SELECT
              ${tokenQuery} AS query,
              ${tokenKind} AS query_kind,
              ${tokenOrder} AS query_order,
              NULL::integer AS id,
              candidate.session_id,
              'session_metadata'::text AS event_type,
              COALESCE(candidate.${source.text}, '') AS searchable_text,
              candidate.updated_at AS created_at,
              (1.0 + ${termCoverage})::double precision AS score,
              '${source.kind}'::text AS match_source,
              '${source.kind}'::text AS relevance_source
            FROM sessions candidate
            WHERE cardinality(${queryTerms}) >= 2
              AND ${candidateTerms} && ${queryTerms}
              AND ${overlappingTerms} >= GREATEST(2, CEIL(cardinality(${queryTerms}) * 0.6))
              AND (${tokenGroup.allowedFolders} IS NULL OR candidate.folder_id = ANY(${tokenGroup.allowedFolders}))
              AND (${tokenGroup.nodeId} IS NULL OR candidate.node_id = ${tokenGroup.nodeId})
              AND (${tokenGroup.statuses} IS NULL OR candidate.status = ANY(${tokenGroup.statuses}))
              AND (${tokenGroup.updatedAfter} IS NULL OR candidate.updated_at >= ${tokenGroup.updatedAfter})
              AND (${tokenGroup.backendFilter} IS NULL OR ${tokenBackend} = ANY(${tokenGroup.backendFilter}))
            ORDER BY ${termCoverage} DESC,
                     candidate.updated_at DESC NULLS LAST,
                     candidate.session_id ASC
            LIMIT ${tokenGroup.limit}
          ) fuzzy_source_candidates
        `);
      }
    }
  });

  const groups = [titlePrefix, promptPrefix, titleTokens, promptTokens];
  if (groups.every((group) => group.branches.length === 0)) {
    return { rows: [], status: "complete" };
  }
  if (sql.unsafe === undefined) {
    throw new Error("parameterized session metadata search requires postgres unsafe bindings");
  }

  const rows: SessionSearchCandidateRow[] = [];
  let failureReason: SessionMetadataCandidateResult["reason"];
  for (const group of groups) {
    if (group.branches.length === 0) continue;
    try {
      assertSearchMayContinue(signal, deadlineAt);
      const queryText = buildMetadataQueryText(group);
      const result = await runSearchQuery(
        activeQuery,
        () => sql.unsafe!(queryText, group.values) as LiveSearchPendingQuery<readonly Record<string, unknown>[]>,
        signal,
        deadlineAt,
        sql,
      ) as readonly SessionSearchCandidateRow[];
      rows.push(...result);
    } catch (error) {
      failureReason ??= metadataFailureReason(error, signal, deadlineAt);
      if (signal.aborted || Date.now() >= deadlineAt) break;
    }
  }

  return failureReason === undefined
    ? { rows, status: "complete" }
    : { rows, status: "partial", reason: failureReason };
}

function buildMetadataQueryText(group: {
  readonly branches: readonly string[];
  readonly limit: string;
  readonly backendCatalog: string;
}): string {
  const { branches, limit, backendCatalog } = group;
  const queryText = `
    WITH metadata_hits AS (
      ${branches.join("\nUNION ALL\n")}
    ),
    best_metadata_per_session AS (
      SELECT DISTINCT ON (session_id) *
      FROM metadata_hits
      ORDER BY session_id, score DESC, query_order ASC, created_at DESC NULLS LAST,
               id ASC NULLS LAST
    ),
    bounded_metadata AS MATERIALIZED (
      SELECT *
      FROM best_metadata_per_session
      ORDER BY score DESC, query_order ASC, created_at DESC NULLS LAST, session_id ASC
      LIMIT ${limit}
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
       FROM jsonb_array_elements(${backendCatalog}) AS mapping(value)
       WHERE mapping.value->>'kind' = 'agent'
         AND mapping.value->>'node_id' = session.node_id
         AND mapping.value->>'agent_id' = session.agent_id
       LIMIT 1) AS agent_name,
      session.review_required,
      session.folder_id,
      session.node_id,
      session.status,
      ${sessionBackendExpression("session", backendCatalog)} AS backend,
      session.caller_session_id AS parent_session_id,
      session.updated_at AS session_updated_at,
      linked_task.id AS task_id,
      linked_task.title AS task_title,
      linked_task.task_evidence_kind,
      linked_task.task_evidence_title
    FROM bounded_metadata hit
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
    ORDER BY hit.query_order, hit.score DESC, hit.session_id ASC
  `;
  return queryText;
}

function metadataFailureReason(
  error: unknown,
  signal: AbortSignal,
  deadlineAt: number,
): "timeout" | "cancelled" | "error" {
  if (signal.aborted) return "cancelled";
  if (Date.now() >= deadlineAt) return "timeout";
  if (error instanceof SearchDeadlineError) return "timeout";
  if (typeof error === "object" && error !== null && "code" in error && error.code === "57014") {
    return "timeout";
  }
  return "error";
}

function sessionBackendExpression(alias: string, backendCatalog: string): string {
  return `COALESCE(
    (SELECT mapping.value->>'backend'
     FROM jsonb_array_elements(${backendCatalog}) AS mapping(value)
     WHERE mapping.value->>'kind' = 'preset'
       AND mapping.value->>'node_id' = ${alias}.node_id
       AND mapping.value->>'model_preset' = ${alias}.model_preset
     LIMIT 1),
    (SELECT mapping.value->>'backend'
     FROM jsonb_array_elements(${backendCatalog}) AS mapping(value)
     WHERE mapping.value->>'kind' = 'agent'
       AND mapping.value->>'node_id' = ${alias}.node_id
       AND mapping.value->>'agent_id' = ${alias}.agent_id
     LIMIT 1)
  )`;
}
