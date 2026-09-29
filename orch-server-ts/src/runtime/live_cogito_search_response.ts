import { buildSearchPreview } from "@soulstream/search-contract";

import type {
  CogitoNavigationSearchResult,
  CogitoSearchParams,
  CogitoSearchResponse,
  CogitoSearchResult,
} from "../cogito/cogito_routes.js";
import {
  projectSessionSearchResults,
  type SessionSearchCandidateRow,
} from "../search/session_search_projection.js";

type SearchStatus = NonNullable<CogitoSearchResponse["search_status"]>;
type SessionSources = NonNullable<SearchStatus["session_sources"]>;

export type LiveCogitoSearchTiming = {
  readonly connectionOpenMs: number;
  readonly metadataSqlMs: number;
  readonly lexicalSqlMs: number;
  readonly documentIndexBuildMs: number;
  readonly originalBodySqlMs: number;
  readonly expansionWaitMs: number;
  readonly semanticSqlMs: number;
  readonly navigationSqlMs: number;
  readonly projectionMs: number;
  readonly totalMs: number;
};

type ProductSearchResponseState = {
  readonly shouldExpand: boolean;
  readonly expandedSessionResults: CogitoSearchResponse["session_results"];
  readonly incompleteSearch: SearchStatus["search"];
  readonly metadataSource: NonNullable<SessionSources["metadata"]>;
  readonly metadataPromptTokensSource:
    | SessionSources["metadata_prompt_tokens"]
    | undefined;
  readonly originalBodySource: NonNullable<SessionSources["original_body"]>;
  readonly semanticBodySource: NonNullable<SessionSources["semantic_body"]>;
  readonly documentSource: SessionSources["session_document"];
  readonly rerankSource: SessionSources["rerank"];
  readonly queryExpansion: SearchStatus["query_expansion"] | undefined;
};

export function finalizeLiveCogitoSearchResponse(input: {
  readonly params: CogitoSearchParams;
  readonly candidateLimit: number;
  readonly searchRows: readonly SessionSearchCandidateRow[];
  readonly navigationRows: readonly Record<string, unknown>[];
  readonly startedAt: number;
  readonly productSearch: ProductSearchResponseState | undefined;
  readonly dbCancelFailed: boolean;
  readonly timing: Omit<LiveCogitoSearchTiming, "projectionMs" | "totalMs">;
  readonly onSearchTiming?: (timing: LiveCogitoSearchTiming) => void;
}): CogitoSearchResponse {
  const projectionStartedAt = Date.now();
  const response: CogitoSearchResponse = {
    results: serializeEventRows(
      input.searchRows.filter((row) => row.query_kind === "original"),
      input.params.q,
      input.candidateLimit,
    ),
    navigation_results: input.navigationRows.map(serializeNavigationRow),
    ...(input.productSearch === undefined
      ? {}
      : {
        session_results: input.productSearch.shouldExpand
          ? input.productSearch.expandedSessionResults ?? []
          : projectSessionSearchResults(
            input.searchRows,
            input.params.q,
            input.candidateLimit,
          ),
        search_status: {
          ...(input.productSearch.incompleteSearch
            ? { search: input.productSearch.incompleteSearch }
            : {}),
          session_sources: {
            metadata: input.productSearch.metadataSource,
            ...(input.productSearch.metadataPromptTokensSource === undefined
              ? {}
              : { metadata_prompt_tokens: input.productSearch.metadataPromptTokensSource }),
            original_body: input.productSearch.originalBodySource,
            semantic_body: input.productSearch.semanticBodySource,
            ...(input.productSearch.shouldExpand
              ? {
                session_document: input.productSearch.documentSource,
                rerank: input.productSearch.rerankSource,
              }
              : {}),
          },
          query_expansion: input.productSearch.queryExpansion ?? {
            status: "skipped",
            latency_ms: 0,
          },
          search_latency_ms: Math.max(0, Date.now() - input.startedAt),
          ...(input.dbCancelFailed ? { db_cancel: "failed" as const } : {}),
        },
      }),
  };
  const projectionMs = Math.max(0, Date.now() - projectionStartedAt);
  try {
    input.onSearchTiming?.({
      ...input.timing,
      projectionMs,
      totalMs: Math.max(0, Date.now() - input.startedAt),
    });
  } catch {
    // Measurement callbacks must not affect query results.
  }
  return response;
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
      folder_id: stringValue(row.folder_id),
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
