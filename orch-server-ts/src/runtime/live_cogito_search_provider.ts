import {
  DEFAULT_SEARCH_CATEGORIES,
  buildSearchPreview,
  eventTypesForSearchCategories,
  parseSearchEventCategories,
} from "@soulstream/search-contract";

import type {
  CogitoNavigationSearchResult,
  CogitoSearchParams,
  CogitoSearchProvider,
  CogitoSearchResult,
} from "../cogito/cogito_routes.js";
import type { LiveDbSqlResolver } from "./live_db_sql.js";

export type CreateLiveCogitoSearchProviderOptions = {
  readonly sqlResolver: LiveDbSqlResolver;
};

export function createLiveCogitoSearchProvider(
  options: CreateLiveCogitoSearchProviderOptions,
): CogitoSearchProvider {
  return {
    async search(params) {
      const sql = await options.sqlResolver.resolveSql();
      const eventTypes = resolveEventTypes(params);
      const eventRows = await sql`
        SELECT *
        FROM event_search(${params.q}, ${null}, ${params.top_k}, ${eventTypes}::text[])
      `;
      const sessionRows = params.search_session_id
        ? await sql`
            SELECT *
            FROM session_id_search(${params.q}, ${eventTypes}::text[], ${params.top_k})
          `
        : [];
      const digestRows = params.include_highlight || params.include_story
        ? await sql`
            SELECT
              d.narrative_through_event_id AS id,
              d.session_id,
              matches.event_type,
              matches.searchable_text,
              1.0 / matches.position AS score,
              matches.match_source
            FROM session_digests d
            CROSS JOIN LATERAL (
              SELECT
                'session_highlight'::text AS event_type,
                d.highlight AS searchable_text,
                STRPOS(LOWER(d.highlight), LOWER(${params.q})) AS position,
                'highlight'::text AS match_source
              WHERE ${params.include_highlight}
              UNION ALL
              SELECT
                'session_story'::text,
                d.narrative,
                STRPOS(LOWER(d.narrative), LOWER(${params.q})),
                'story'::text
              WHERE ${params.include_story}
            ) matches
            WHERE matches.position > 0
            ORDER BY score DESC, d.updated_at DESC, d.session_id ASC
            LIMIT ${params.top_k}
          `
        : [];
      const navigationRows = await sql`
        SELECT *
        FROM (
          SELECT
            'folder'::text AS kind,
            f.id,
            f.name AS title,
            f.id AS folder_id,
            f.project_page_id,
            NULL::text AS board_item_id,
            NULL::text AS task_page_id
          FROM folders f
          WHERE f.archived = FALSE
            AND f.project_page_id IS NOT NULL
            AND f.name ILIKE ${`%${params.q}%`}
          UNION ALL
          SELECT
            'task'::text AS kind,
            t.id,
            t.title,
            bi.folder_id,
            f.project_page_id,
            t.board_item_id,
            t.task_page_id
          FROM tasks t
          JOIN board_items bi ON bi.id = t.board_item_id
          JOIN folders f ON f.id = bi.folder_id
          WHERE t.archived = FALSE
            AND f.archived = FALSE
            AND t.task_page_id IS NOT NULL
            AND f.project_page_id IS NOT NULL
            AND t.title ILIKE ${`%${params.q}%`}
        ) navigation
        ORDER BY title ASC, id ASC
        LIMIT ${params.top_k}
      `;
      return {
        results: serializeEventRows(
          [...eventRows, ...sessionRows, ...digestRows],
          params.q,
          params.top_k,
        ),
        navigation_results: navigationRows.map(serializeNavigationRow),
      };
    },
  };
}

function resolveEventTypes(params: CogitoSearchParams): string[] {
  const legacy = splitCommaList(params.event_types);
  const resolved = legacy ?? eventTypesForSearchCategories(
    parseSearchEventCategories(params.event_categories) ??
      [...DEFAULT_SEARCH_CATEGORIES],
  );
  if (params.include_turn_summaries && !resolved.includes("turn_summary")) {
    resolved.push("turn_summary");
  }
  return resolved;
}

function serializeEventRows(
  rows: readonly Record<string, unknown>[],
  query: string,
  limit: number,
): CogitoSearchResult[] {
  const unique = new Map<string, CogitoSearchResult>();
  for (const row of rows) {
    const sessionId = stringValue(row.session_id);
    const eventId = numberValue(row.id);
    if (sessionId === null || eventId === null) continue;
    const matchSource = searchMatchSource(row);
    const key = `${sessionId}:${eventId}:${matchSource}`;
    if (unique.has(key)) continue;
    const searchableText = stringValue(row.searchable_text) ?? "";
    unique.set(key, {
      session_id: sessionId,
      event_id: eventId,
      score: numberValue(row.score) ?? 0,
      preview: buildSearchPreview(searchableText, query),
      event_type: stringValue(row.event_type) ?? "",
      match_source: matchSource,
    });
  }
  return [...unique.values()]
    .sort((left, right) => scoreValue(right) - scoreValue(left))
    .slice(0, limit);
}

function searchMatchSource(
  row: Record<string, unknown>,
): "message" | "turn_summary" | "highlight" | "story" {
  const explicit = stringValue(row.match_source);
  if (explicit === "highlight" || explicit === "story") return explicit;
  return stringValue(row.event_type) === "turn_summary"
    ? "turn_summary"
    : "message";
}

function serializeNavigationRow(
  row: Record<string, unknown>,
): CogitoNavigationSearchResult {
  const common = {
    kind: stringValue(row.kind) ?? "",
    id: stringValue(row.id) ?? "",
    title: stringValue(row.title) ?? "",
    folder_id: stringValue(row.folder_id) ?? "",
    project_page_id: stringValue(row.project_page_id) ?? "",
  };
  if (common.kind !== "task") return common;
  return {
    ...common,
    board_item_id: stringValue(row.board_item_id) ?? "",
    task_page_id: stringValue(row.task_page_id) ?? "",
  };
}

function splitCommaList(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : null;
}

function scoreValue(result: CogitoSearchResult): number {
  return typeof result.score === "number" ? result.score : 0;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
