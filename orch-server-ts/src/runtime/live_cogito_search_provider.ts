import {
  DEFAULT_SEARCH_CATEGORIES,
  buildSearchPreview,
  eventTypesForSearchCategories,
  parseSearchEventCategories,
} from "@soulstream/search-contract";

import {
  COGITO_SEARCH_DEADLINE_MS,
  type CogitoNavigationSearchResult,
  type CogitoSearchParams,
  type CogitoSearchProvider,
  type CogitoSearchResult,
  type CogitoSearchResponse,
} from "../cogito/cogito_routes.js";
import {
  CodexEphemeralExecutionError,
} from "../llm/codex_ephemeral_executor.js";
import type { SearchQueryExpander } from "../search/search_query_expander.js";
import {
  SearchQueryModelConfigurationError,
} from "../search/search_query_model_resolver.js";
import {
  projectSessionSearchResults,
  type SessionSearchCandidateRow,
} from "../search/session_search_projection.js";
import {
  assertSearchMayContinue,
  buildQueryVariants,
  buildSemanticVariants,
  isSearchStopped,
  loadCandidateRows,
  runSearchQuery,
  SearchDeadlineError,
} from "./live_session_search_candidates.js";
import type {
  LiveSearchDbConnectionFactory,
  LiveSearchPendingQuery,
  LiveSearchSql,
} from "./live_db_sql.js";
import type { SessionBackendCatalogEntry } from "./live_session_serialization.js";
import { cancelLiveSearchQuerySafely } from "./live_db_sql.js";

const SEARCH_DB_CONCURRENCY_LIMIT = 2;
const CANDIDATE_MULTIPLIER = 5;
const QUERY_EXPANSION_TIMEOUT_MS = 4_500;

export type CreateLiveCogitoSearchProviderOptions = {
  readonly searchDbConnectionFactory: LiveSearchDbConnectionFactory;
  readonly queryExpander?: SearchQueryExpander;
  readonly queryExpansionTimeoutMs?: number;
  readonly sessionBackendCatalog?: () => readonly SessionBackendCatalogEntry[];
  readonly onCancelError?: (error: unknown) => void;
  readonly onSearchTiming?: (timing: {
    readonly connectionOpenMs: number;
    readonly lexicalSqlMs: number;
    readonly expansionWaitMs: number;
    readonly semanticSqlMs: number;
    readonly navigationSqlMs: number;
    readonly projectionMs: number;
    readonly totalMs: number;
  }) => void;
};

export function createLiveCogitoSearchProvider(
  options: CreateLiveCogitoSearchProviderOptions,
): CogitoSearchProvider {
  const acquireSearchSlot = createSearchConcurrencyLimiter(SEARCH_DB_CONCURRENCY_LIMIT);
  return {
    async search(params) {
      const startedAt = Date.now();
      const deadlineAt = params.deadlineAt ?? startedAt + COGITO_SEARCH_DEADLINE_MS;
      const searchController = new AbortController();
      let deadlineExpired = false;
      const deadlineTimer = setTimeout(() => {
        deadlineExpired = true;
        searchController.abort(new SearchDeadlineError("search request deadline exceeded"));
      }, Math.max(1, deadlineAt - Date.now()));
      const forwardAbort = () => searchController.abort(params.signal?.reason);
      if (params.signal?.aborted) forwardAbort();
      else params.signal?.addEventListener("abort", forwardAbort, { once: true });
      const signal = searchController.signal;
      const expansionController = new AbortController();
      const forwardExpansionAbort = () => expansionController.abort(signal.reason);
      if (signal.aborted) forwardExpansionAbort();
      else signal.addEventListener("abort", forwardExpansionAbort, { once: true });
      const isProductSearch = params.include_session_results === true;
      const searchParams = {
        ...params,
        ...(isProductSearch
          ? { allowedFolderIds: resolveProductFolderScope(params) }
          : {}),
        signal,
      };
      const backendCatalog = isProductSearch
        ? options.sessionBackendCatalog?.() ?? []
        : [];
      const shouldExpand = isProductSearch && params.session_search_mode !== "lexical";
      const candidateLimit = Math.min(100, params.top_k * CANDIDATE_MULTIPLIER);
      const eventTypes = resolveEventTypes(params);
      const allowedFolderIds = params.allowedFolderIds ?? null;
      const activeQuery: {
        current?: LiveSearchPendingQuery<readonly Record<string, unknown>[]>;
      } = {};
      let connection: Awaited<ReturnType<LiveSearchDbConnectionFactory["open"]>> | undefined;
      let discardPromise: Promise<void> | undefined;
      let releaseSlot: (() => void) | undefined;
      let cancelFailed = false;
      let cleanupFailed = false;
      let cleanupErrorReported = false;
      let queryExpansion:
        | NonNullable<CogitoSearchResponse["search_status"]>["query_expansion"]
        | undefined;
      if (isProductSearch && !shouldExpand) {
        queryExpansion = { status: "skipped", latency_ms: 0 };
      }
      let semanticSearchCompleted = false;
      let searchStage: "lexical" | "semantic" | "navigation" = "lexical";
      let incompleteSearch:
        | NonNullable<CogitoSearchResponse["search_status"]>["search"]
        | undefined;
      const searchRows: SessionSearchCandidateRow[] = [];
      let navigationRows: readonly Record<string, unknown>[] = [];
      let connectionOpenMs = 0;
      let lexicalSqlMs = 0;
      let expansionWaitMs = 0;
      let semanticSqlMs = 0;
      let navigationSqlMs = 0;
      const discardConnection = () => {
        if (discardPromise === undefined && connection?.discard !== undefined) {
          discardPromise = connection.discard();
        }
        return discardPromise;
      };
      const reportSearchCleanupError = (error: unknown) => {
        cleanupFailed = true;
        if (cleanupErrorReported) return;
        cleanupErrorReported = true;
        try {
          options.onCancelError?.(error);
        } catch {
          // Reporting must not replace a valid partial lexical response.
        }
      };
      const onAbort = () => {
        const query = activeQuery.current;
        if (query !== undefined) {
          cancelLiveSearchQuerySafely(query, (error) => {
            cancelFailed = true;
            reportSearchCleanupError(error);
          });
        }
        try {
          const discard = discardConnection();
          if (discard !== undefined) void discard.catch(reportSearchCleanupError);
        } catch (error) {
          reportSearchCleanupError(error);
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });

      let expansionPromise: Promise<ExpansionOutcome> | undefined;
      let expansionPending = false;
      try {
        releaseSlot = await acquireSearchSlot(signal, deadlineAt);
        assertSearchMayContinue(signal, deadlineAt);
        const remainingBudgetMs = Math.floor(deadlineAt - Date.now());
        if (remainingBudgetMs < 1_000) {
          throw new SearchDeadlineError("search request deadline is too near for a database connection");
        }
        const connectionStartedAt = Date.now();
        connection = await options.searchDbConnectionFactory.open(remainingBudgetMs);
        connectionOpenMs = Math.max(0, Date.now() - connectionStartedAt);
        assertSearchMayContinue(signal, deadlineAt);
        const baseVariants = buildQueryVariants(params.q, [], isProductSearch);
        if (shouldExpand) {
          expansionPending = true;
          expansionPromise = startExpansion(
            options.queryExpander,
            params.q,
            deadlineAt,
            expansionController.signal,
            options.queryExpansionTimeoutMs ?? QUERY_EXPANSION_TIMEOUT_MS,
          ).finally(() => { expansionPending = false; });
        }

        const lexicalStartedAt = Date.now();
        searchRows.push(...await loadCandidateRows({
          sql: connection.sql,
          variants: baseVariants,
          params: searchParams,
          eventTypes,
          candidateLimit: isProductSearch ? candidateLimit : params.top_k,
          activeQuery,
          deadlineAt,
          includeSessionMetadataSearch: isProductSearch,
          backendCatalog,
        }));
        lexicalSqlMs = Math.max(0, Date.now() - lexicalStartedAt);
        searchStage = "semantic";
        if (expansionPromise) {
          const expansionWaitStartedAt = Date.now();
          const expansion = await expansionPromise;
          expansionWaitMs = Math.max(0, Date.now() - expansionWaitStartedAt);
          const expansionReason = deadlineExpired ? "timeout" : expansion.reason;
          queryExpansion = {
            status: deadlineExpired ? "partial" : expansion.status,
            ...(expansionReason === undefined ? {} : { reason: expansionReason }),
            latency_ms: expansion.latencyMs,
          };
          const semanticVariants = buildSemanticVariants(expansion.queries);
          if (semanticVariants.length === 0) {
            semanticSearchCompleted = true;
            if (expansion.status === "expanded") {
              queryExpansion = {
                status: "partial",
                reason: "model_error",
                latency_ms: expansion.latencyMs,
              };
            }
          } else {
            assertSearchMayContinue(signal, deadlineAt);
            const semanticStartedAt = Date.now();
            searchRows.push(...await loadCandidateRows({
              sql: connection.sql,
              variants: semanticVariants,
              params: searchParams,
              eventTypes,
              candidateLimit,
              activeQuery,
              deadlineAt,
              includeSessionMetadataSearch: true,
              backendCatalog,
            }));
            semanticSqlMs = Math.max(0, Date.now() - semanticStartedAt);
            semanticSearchCompleted = true;
          }
        }

        searchStage = "navigation";
        assertSearchMayContinue(signal, deadlineAt);
        const navigationStartedAt = Date.now();
        navigationRows = await runSearchQuery(activeQuery, () => connection!.sql`
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
              AND (${allowedFolderIds}::text[] IS NULL
                OR f.id = ANY(${allowedFolderIds}::text[]))
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
              AND (${allowedFolderIds}::text[] IS NULL
                OR f.id = ANY(${allowedFolderIds}::text[]))
              AND t.title ILIKE ${`%${params.q}%`}
          ) navigation
          ORDER BY title ASC, id ASC
          LIMIT ${Math.min(500, candidateLimit)}
        `, signal, deadlineAt, connection.sql);
        navigationSqlMs = Math.max(0, Date.now() - navigationStartedAt);
      } catch (error) {
        if (expansionPending) {
          if (!expansionController.signal.aborted) expansionController.abort(error);
          await expansionPromise;
        }
        if (!signal.aborted && (error instanceof SearchDeadlineError || Date.now() >= deadlineAt)) {
          deadlineExpired = true;
          searchController.abort(error);
        }
        if (!isSearchStopped(error, signal)) throw error;
        if (!isProductSearch && (deadlineExpired || Date.now() >= deadlineAt)) {
          throw new SearchDeadlineError("search request deadline exceeded");
        }
        if (isProductSearch) {
          const stopReason = deadlineExpired || Date.now() >= deadlineAt
            ? "timeout"
            : "cancelled";
          incompleteSearch = {
            status: "partial",
            stage: searchStage,
            reason: stopReason,
          };
          if (!queryExpansion) {
            queryExpansion = {
              status: "partial",
              reason: stopReason,
              latency_ms: 0,
            };
          } else if (queryExpansion.status === "expanded" && !semanticSearchCompleted) {
            queryExpansion = {
              ...queryExpansion,
              status: "partial",
              reason: stopReason,
            };
          }
        }
      } finally {
        clearTimeout(deadlineTimer);
        params.signal?.removeEventListener("abort", forwardAbort);
        signal.removeEventListener("abort", forwardExpansionAbort);
        signal.removeEventListener("abort", onAbort);
        try {
          if (connection !== undefined) {
            if (signal.aborted && connection.discard !== undefined) {
              await (discardConnection() ?? connection.discard());
            } else {
              await connection.close();
            }
          }
        } catch (error) {
          reportSearchCleanupError(error);
        } finally {
          releaseSlot?.();
        }
      }

      const eventRows = searchRows.filter((row) => row.query_kind === "original");
      const projectionStartedAt = Date.now();
      const response: CogitoSearchResponse = {
        results: serializeEventRows(eventRows, params.q, candidateLimit),
        navigation_results: navigationRows.map(serializeNavigationRow),
        ...(isProductSearch
          ? {
            session_results: projectSessionSearchResults(
              searchRows,
              params.q,
              candidateLimit,
            ),
            search_status: {
              ...(incompleteSearch ? { search: incompleteSearch } : {}),
              query_expansion: queryExpansion ?? {
                status: "partial",
                reason: "configuration",
                latency_ms: 0,
              },
              search_latency_ms: Math.max(0, Date.now() - startedAt),
              ...(cancelFailed || cleanupFailed ? { db_cancel: "failed" as const } : {}),
            },
          }
          : {}),
      };
      const projectionMs = Math.max(0, Date.now() - projectionStartedAt);
      try {
        options.onSearchTiming?.({
          connectionOpenMs,
          lexicalSqlMs,
          expansionWaitMs,
          semanticSqlMs,
          navigationSqlMs,
          projectionMs,
          totalMs: Math.max(0, Date.now() - startedAt),
        });
      } catch {
        // Measurement callbacks must not affect query results.
      }
      return response;
    },
  };
}

function resolveProductFolderScope(
  params: CogitoSearchParams,
): readonly string[] | undefined {
  const selectedFolderId = params.session_filters?.folder_id;
  if (selectedFolderId === undefined) return params.allowedFolderIds;
  if (params.allowedFolderIds === undefined) return [selectedFolderId];
  return params.allowedFolderIds.filter((folderId) => folderId === selectedFolderId);
}

type ExpansionOutcome = {
  readonly queries: readonly string[];
  readonly latencyMs: number;
  readonly status: "expanded" | "skipped" | "partial";
  readonly reason?: "configuration" | "timeout" | "cancelled" | "model_error";
};

function startExpansion(
  queryExpander: SearchQueryExpander | undefined,
  query: string,
  deadlineAt: number,
  signal: AbortSignal | undefined,
  maxExpansionTimeoutMs: number,
): Promise<ExpansionOutcome> {
  if (!queryExpander) {
    return Promise.resolve({
      queries: [],
      latencyMs: 0,
      status: "partial",
      reason: "configuration",
    });
  }
  const startedAt = Date.now();
  const timeoutMs = Math.max(1, Math.min(
    maxExpansionTimeoutMs,
    deadlineAt - startedAt,
  ));
  return queryExpander.expand(query, timeoutMs, signal).then((result): ExpansionOutcome => ({
    queries: result.queries,
    latencyMs: result.latencyMs,
    status: result.skipped ? "skipped" : "expanded",
  })).catch((error: unknown) => ({
    queries: [],
    latencyMs: Math.max(0, Date.now() - startedAt),
    status: "partial",
    reason: expansionFailureReason(error),
  }));
}

function createSearchConcurrencyLimiter(limit: number): (
  signal: AbortSignal | undefined,
  deadlineAt: number,
) => Promise<() => void> {
  let active = 0;
  const waiters: Array<{
    readonly resolve: (release: () => void) => void;
    readonly reject: (error: Error) => void;
    readonly signal?: AbortSignal;
    timer: ReturnType<typeof setTimeout>;
    onAbort?: () => void;
  }> = [];

  const releaseFactory = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (waiters.length > 0) {
        const next = waiters.shift()!;
        clearTimeout(next.timer);
        next.signal?.removeEventListener("abort", next.onAbort!);
        next.resolve(releaseFactory());
        return;
      }
      active -= 1;
    };
  };

  return (signal, deadlineAt) => {
    if (signal?.aborted) return Promise.reject(new SearchDeadlineError("search request was cancelled"));
    if (Date.now() >= deadlineAt) return Promise.reject(new SearchDeadlineError("search request deadline exceeded"));
    if (active < limit) {
      active += 1;
      return Promise.resolve(releaseFactory());
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        timer: setTimeout(() => {
          removeWaiter(waiter);
          reject(new SearchDeadlineError("search request deadline exceeded while queued"));
        }, Math.max(1, deadlineAt - Date.now())),
        onAbort: undefined as (() => void) | undefined,
      };
      waiter.onAbort = () => {
        removeWaiter(waiter);
        reject(new SearchDeadlineError("search request was cancelled while queued"));
      };
      const removeWaiter = (value: typeof waiter) => {
        const index = waiters.indexOf(value);
        if (index >= 0) waiters.splice(index, 1);
        clearTimeout(value.timer);
        value.signal?.removeEventListener("abort", value.onAbort!);
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      waiters.push(waiter);
    });
  };
}

function expansionFailureReason(
  error: unknown,
): NonNullable<CogitoSearchResponse["search_status"]>["query_expansion"]["reason"] {
  if (error instanceof SearchQueryModelConfigurationError) return "configuration";
  if (error instanceof CodexEphemeralExecutionError) {
    if (error.code === "CODEX_TIMEOUT") return "timeout";
    if (error.code === "CODEX_CANCELLED") return "cancelled";
  }
  return "model_error";
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
