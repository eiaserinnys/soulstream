import { compactSearchQuery } from "@soulstream/search-contract";

import type { CogitoSearchParams } from "../cogito/cogito_routes.js";
import type { SessionSearchCandidateRow } from "../search/session_search_projection.js";
import { runSearchQuery, type QueryVariant } from "./live_session_search_candidates.js";
import type { SessionBackendCatalogEntry } from "./live_session_serialization.js";
import type {
  LiveSearchPendingQuery,
  LiveSearchSql,
} from "./live_db_sql.js";

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
): Promise<readonly SessionSearchCandidateRow[]> {
  const { sql, variants, params, candidateLimit, activeQuery, deadlineAt, signal } = input;
  if (variants.length === 0) return [];

  const allowedFolderIds = params.allowedFolderIds ?? null;
  const sessionFilters = params.session_filters;
  const backends = sessionFilters?.backends?.length ? sessionFilters.backends : null;
  const values: unknown[] = [];
  const bind = (value: unknown, type: string): string => {
    values.push(value);
    return `$${values.length}::${type}`;
  };
  const allowedFolders = bind(allowedFolderIds, "text[]");
  const nodeId = bind(sessionFilters?.node_id ?? null, "text");
  const statuses = bind(sessionFilters?.statuses?.length ? sessionFilters.statuses : null, "text[]");
  const updatedAfter = bind(sessionFilters?.updated_after ?? null, "timestamptz");
  const backendFilter = bind(backends, "text[]");
  const backendCatalog = bind(input.backendCatalog, "jsonb");
  const limit = bind(candidateLimit, "integer");
  const branches: string[] = [];

  variants.forEach((variant, index) => {
    if (!compactSearchQuery(variant.query) || !/[\p{L}\p{N}]/u.test(variant.query)) return;
    for (const source of [
      { key: "display_name_search_key", text: "display_name", kind: "title" },
      { key: "prompt_search_key", text: "prompt", kind: "prompt" },
    ] as const) {
      const query = bind(variant.query, "text");
      const queryKind = bind(variant.kind, "text");
      const queryOrder = bind(index + 1, "integer");
      // PostgreSQL's POSIX punctuation class is the canonical search-key normalizer.
      // It removes some Unicode symbols that the JS \\p{P} normalizer preserves.
      const compactQuery = `session_search_compact(${query})`;
      const backend = sessionBackendExpression("candidate", backendCatalog);
      branches.push(`
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
            AND (${allowedFolders} IS NULL OR candidate.folder_id = ANY(${allowedFolders}))
            AND (${nodeId} IS NULL OR candidate.node_id = ${nodeId})
            AND (${statuses} IS NULL OR candidate.status = ANY(${statuses}))
            AND (${updatedAfter} IS NULL OR candidate.updated_at >= ${updatedAfter})
            AND (${backendFilter} IS NULL OR ${backend} = ANY(${backendFilter}))
            AND session_search_index_prefix(candidate.${source.key})
                LIKE session_search_index_prefix(${compactQuery}) || '%'
            AND candidate.${source.key} LIKE ${compactQuery} || '%'
          ORDER BY (candidate.${source.key} = ${compactQuery}) DESC,
                   candidate.updated_at DESC NULLS LAST,
                   candidate.session_id ASC
          LIMIT ${limit}
        ) source_candidates
      `);
    }
  });

  if (branches.length === 0) return [];
  if (sql.unsafe === undefined) {
    throw new Error("parameterized session metadata search requires postgres unsafe bindings");
  }

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

  return await runSearchQuery(
    activeQuery,
    () => sql.unsafe!(queryText, values) as LiveSearchPendingQuery<readonly Record<string, unknown>[]>,
    signal,
    deadlineAt,
    sql,
  ) as readonly SessionSearchCandidateRow[];
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
