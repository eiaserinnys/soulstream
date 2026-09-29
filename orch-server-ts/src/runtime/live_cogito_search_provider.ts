import {
  cogitoSearchDeadlineMs,
  type CogitoSearchProvider,
  type CogitoSearchResponse,
} from "../cogito/cogito_routes.js";
import {
  projectSessionSearchResults,
  type SessionSearchCandidateRow,
} from "../search/session_search_projection.js";
import { rerankSessionDocuments } from "../search/jev_session_reranker.js";
import {
  buildSessionSearchRrfPool,
  filterTitleResultsToIndexedSessions,
  orderSessionSearchResults,
  type SessionSearchPoolResult,
} from "../search/session_search_rrf.js";
import {
  LiveSessionDocumentSearch,
  loadSessionDocumentCandidateRows,
} from "./live_session_document_search.js";
import {
  assertSearchMayContinue,
  buildQueryVariants,
  isSearchStopped,
  loadCandidateRows,
  runSearchQuery,
  SearchDeadlineError,
} from "./live_session_search_candidates.js";
import {
  loadSessionMetadataCandidateRows,
  type SessionMetadataCandidateResult,
} from "./live_session_metadata_candidates.js";
import type {
  LiveSearchDbConnectionFactory,
  LiveSearchPendingQuery,
  LiveSearchSql,
} from "./live_db_sql.js";
import type { SessionBackendCatalogEntry } from "./live_session_serialization.js";
import { cancelLiveSearchQuerySafely } from "./live_db_sql.js";
import {
  createSearchConcurrencyLimiter,
  resolveEventTypes,
  resolveProductFolderScope,
  sourceFailureReason,
} from "./live_cogito_search_helpers.js";
import {
  finalizeLiveCogitoSearchResponse,
  type LiveCogitoSearchTiming,
} from "./live_cogito_search_response.js";

const SEARCH_DB_CONCURRENCY_LIMIT = 2;
const CANDIDATE_MULTIPLIER = 5;

export type CreateLiveCogitoSearchProviderOptions = {
  readonly searchDbConnectionFactory: LiveSearchDbConnectionFactory;
  readonly typesafeApiKey?: string | null;
  readonly jevFetcher?: typeof fetch;
  readonly sessionBackendCatalog?: () => readonly SessionBackendCatalogEntry[];
  readonly onCancelError?: (error: unknown) => void;
  readonly onSearchTiming?: (timing: LiveCogitoSearchTiming) => void;
};

export function createLiveCogitoSearchProvider(
  options: CreateLiveCogitoSearchProviderOptions,
): CogitoSearchProvider {
  const acquireSearchSlot = createSearchConcurrencyLimiter(SEARCH_DB_CONCURRENCY_LIMIT);
  const documentSearch = new LiveSessionDocumentSearch();
  return {
    async search(params) {
      const startedAt = Date.now();
      const deadlineAt = params.deadlineAt ?? startedAt + cogitoSearchDeadlineMs(params);
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
      if (isProductSearch) {
        queryExpansion = { status: "skipped", latency_ms: 0 };
      }
      let searchStage: "lexical" | "semantic" | "navigation" = "lexical";
      let incompleteSearch:
        | NonNullable<CogitoSearchResponse["search_status"]>["search"]
        | undefined;
      type SourceState = NonNullable<CogitoSearchResponse["search_status"]>["session_sources"];
      let metadataSource: NonNullable<SourceState>["metadata"] = { status: "partial", reason: "error" };
      let metadataPromptTokensSource: NonNullable<SourceState>["metadata_prompt_tokens"];
      let metadataAttempted = false;
      let originalBodySource: NonNullable<SourceState>["original_body"] = { status: "deferred" };
      let semanticBodySource: NonNullable<SourceState>["semantic_body"] = { status: "deferred" };
      let documentSource: {
        readonly status: "complete" | "partial";
        readonly reason?: "timeout" | "cancelled" | "error";
      } = { status: "partial", reason: "error" };
      let rerankSource: {
        readonly status: "complete" | "partial";
        readonly reason?: "timeout" | "error";
        readonly latency_ms: number;
      } = { status: "partial", reason: "error", latency_ms: 0 };
      const searchRows: SessionSearchCandidateRow[] = [];
      let expandedSessionResults: CogitoSearchResponse["session_results"];
      const recordMetadataResult = (
        result: SessionMetadataCandidateResult,
        stage: "lexical" | "semantic",
        promptTokens = false,
      ) => {
        searchRows.push(...result.rows);
        if (result.promptTokenStatus.status === "complete") {
          metadataPromptTokensSource = undefined;
        } else if (
          result.promptTokenStatus.status === "partial"
          || metadataPromptTokensSource?.status !== "partial"
        ) {
          metadataPromptTokensSource = result.promptTokenStatus;
        }
        if (promptTokens) {
          if (result.status === "partial") {
            incompleteSearch ??= {
              status: "partial",
              stage,
              reason: result.reason ?? "error",
            };
          }
          return;
        }
        if (result.status === "partial") {
          const reason = result.reason ?? "error";
          if (!metadataAttempted || metadataSource.status === "complete") {
            metadataSource = { status: "partial", reason };
          }
          incompleteSearch ??= { status: "partial", stage, reason };
        } else if (!metadataAttempted) {
          metadataSource = { status: "complete" };
        }
        metadataAttempted = true;
      };
      const recordMetadataFailure = (
        error: unknown,
        stage: "lexical" | "semantic",
        promptTokens = false,
      ) => {
        const reason = sourceFailureReason(error, signal, deadlineAt, deadlineExpired);
        if (promptTokens) {
          metadataPromptTokensSource = { status: "partial", reason };
        } else {
          if (!metadataAttempted || metadataSource.status === "complete") {
            metadataSource = { status: "partial", reason };
          }
          metadataAttempted = true;
        }
        incompleteSearch ??= { status: "partial", stage, reason };
      };
      let navigationRows: readonly Record<string, unknown>[] = [];
      let connectionOpenMs = 0;
      let metadataSqlMs = 0;
      let lexicalSqlMs = 0;
      let originalBodySqlMs = 0;
      let expansionWaitMs = 0;
      let semanticSqlMs = 0;
      let documentIndexBuildMs = 0;
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
        if (isProductSearch) {
          const metadataStartedAt = Date.now();
          try {
            const metadataResult = await loadSessionMetadataCandidateRows({
              sql: connection.sql,
              variants: baseVariants,
              params: searchParams,
              candidateLimit,
              activeQuery,
              deadlineAt,
              signal,
              backendCatalog,
              phase: "fast",
            });
            recordMetadataResult(metadataResult, "lexical");
          } catch (error) {
            recordMetadataFailure(error, "lexical");
          }
          metadataSqlMs = Math.max(0, Date.now() - metadataStartedAt);
          lexicalSqlMs += metadataSqlMs;
          if (shouldExpand) {
            searchStage = "semantic";
            try {
              assertSearchMayContinue(signal, deadlineAt);
              const remainingBudgetMs = Math.max(1, Math.floor(deadlineAt - Date.now() - 1_000));
              await connection.sql.setStatementTimeout?.(remainingBudgetMs);
              documentIndexBuildMs = await documentSearch.refresh({
                sql: connection.sql,
                activeQuery,
                deadlineAt,
                signal,
              });
              const lexicalTitles = projectSessionSearchResults(searchRows, params.q, candidateLimit);
              const titleResults = filterTitleResultsToIndexedSessions(
                lexicalTitles,
                (sessionId) => documentSearch.index.has(sessionId),
              );
              const rankedTitles = titleResults as SessionSearchPoolResult[];
              const titleOnlyPool = buildSessionSearchRrfPool(
                rankedTitles,
                [],
                (sessionId) => documentSearch.index.get(sessionId)!.card,
                50,
              );
              expandedSessionResults = orderSessionSearchResults(titleOnlyPool, null)
                .slice(0, params.top_k)
                .map(({ result, relevance }) => ({ ...result, relevance }));
              const documentHits = documentSearch.index.search(params.q, 300);
              const documentById = new Map(documentHits.map((hit) => [hit.session_id, hit]));
              const documentQueryStartedAt = Date.now();
              const documentRows = await loadSessionDocumentCandidateRows({
                sql: connection.sql,
                sessionIds: documentHits.map((hit) => hit.session_id),
                params: searchParams,
                activeQuery,
                deadlineAt,
                signal,
                backendCatalog,
                limit: 100,
              });
              semanticSqlMs = Math.max(0, Date.now() - documentQueryStartedAt);
              const rankedDocuments = documentRows.flatMap((row) => {
                const document = documentById.get(row.session_id);
                if (!document) return [];
                const excerptSource = document.summary || document.request || document.title || "";
                const excerpt = Array.from(excerptSource).slice(0, 160).join("");
                const projected = projectSessionSearchResults([{
                  ...row,
                  query_kind: "original",
                  event_type: "session_document",
                  id: null,
                  searchable_text: excerptSource,
                  created_at: row.session_updated_at,
                  score: document.score,
                  match_source: "session_document",
                  relevance_source: "session_document",
                }], params.q, 1)[0];
                if (!projected) return [];
                return [{
                  ...projected,
                  excerpt,
                  best_match: { event_id: null, match_source: "session_document", excerpt },
                  evidence: [{ source: "session_document", event_id: null, excerpt }],
                  relevance: null,
                } as SessionSearchPoolResult];
              });
              const pool = buildSessionSearchRrfPool(
                rankedTitles,
                rankedDocuments,
                (sessionId) => documentSearch.index.get(sessionId)!.card,
                50,
              );
              documentSource = { status: "complete" };
              const rerank = await rerankSessionDocuments(
                options.typesafeApiKey ?? null,
                params.q,
                pool.map(({ session_id, card }) => ({ session_id, card })),
                {
                  ...(options.jevFetcher === undefined ? {} : { fetcher: options.jevFetcher }),
                  signal,
                },
              );
              rerankSource = {
                status: rerank.status,
                latency_ms: rerank.latencyMs,
                ...(rerank.status === "partial" ? { reason: rerank.reason } : {}),
              };
              expansionWaitMs = rerank.latencyMs;
              if (rerank.status === "partial") {
                incompleteSearch ??= {
                  status: "partial",
                  stage: "semantic",
                  reason: rerank.reason,
                };
              }
              expandedSessionResults = orderSessionSearchResults(pool, rerank.scores)
                .slice(0, params.top_k)
                .map(({ result, relevance }) => ({ ...result, relevance }));
            } catch (error) {
              const reason = sourceFailureReason(error, signal, deadlineAt, deadlineExpired);
              documentSource = { status: "partial", reason };
              incompleteSearch ??= { status: "partial", stage: "semantic", reason };
            }
          }
        } else {
          const lexicalStartedAt = Date.now();
          searchRows.push(...await loadCandidateRows({
            sql: connection.sql,
            variants: baseVariants,
            params: searchParams,
            eventTypes,
            candidateLimit: params.top_k,
            activeQuery,
            deadlineAt,
            productSessionSearch: false,
            backendCatalog,
          }));
          lexicalSqlMs = Math.max(0, Date.now() - lexicalStartedAt);
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
        if (!signal.aborted && (error instanceof SearchDeadlineError || Date.now() >= deadlineAt)) {
          deadlineExpired = true;
          searchController.abort(error);
        }
        if (!isSearchStopped(error, signal)) throw error;
        if (!isProductSearch && (deadlineExpired || Date.now() >= deadlineAt)) {
          throw new SearchDeadlineError("search request deadline exceeded");
        }
        if (isProductSearch) {
          const stopReason = sourceFailureReason(error, signal, deadlineAt, deadlineExpired);
          incompleteSearch ??= {
            status: "partial",
            stage: searchStage,
            reason: stopReason,
          };
          if (metadataSource.status === "partial" && metadataSource.reason === "error") {
            metadataSource = { status: "partial", reason: stopReason };
          }
          if (shouldExpand) {
            documentSource = { status: "partial", reason: stopReason };
          }
        }
      } finally {
        clearTimeout(deadlineTimer);
        params.signal?.removeEventListener("abort", forwardAbort);
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

      return finalizeLiveCogitoSearchResponse({
        params,
        candidateLimit,
        searchRows,
        navigationRows,
        startedAt,
        productSearch: isProductSearch
          ? {
            shouldExpand,
            expandedSessionResults,
            incompleteSearch,
            metadataSource,
            metadataPromptTokensSource,
            originalBodySource,
            semanticBodySource,
            documentSource,
            rerankSource,
            queryExpansion,
          }
          : undefined,
        dbCancelFailed: cancelFailed || cleanupFailed,
        timing: {
          connectionOpenMs,
          metadataSqlMs,
          lexicalSqlMs,
          documentIndexBuildMs,
          originalBodySqlMs,
          expansionWaitMs,
          semanticSqlMs,
          navigationSqlMs,
        },
        onSearchTiming: options.onSearchTiming,
      });
    },
  };
}
