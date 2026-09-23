/**
 * useSessionSearch - 세션 기록 BM25 전문 검색 hook (unified-dashboard)
 *
 * /cogito/search 엔드포인트를 호출하여 세션 이벤트를 검색합니다.
 * soul-dashboard의 useSessionSearch.ts에서 포팅.
 * orch의 /cogito/search가 공유 PostgreSQL을 직접 조회합니다.
 */

import { useState, useCallback, useRef } from "react";
import { useUiEventTracker } from "@seosoyoung/soul-ui";
import {
  DEFAULT_SEARCH_CATEGORIES,
  type SearchEventCategory,
} from "@soulstream/search-contract";

export interface SearchResultItem {
  session_id: string;
  event_id: number;
  score: number;
  preview: string;
  event_type: string;
  match_source: SearchMatchSource;
}

export interface SearchSessionResult {
  session_id: string;
  title: string;
  excerpt: string;
  updated_at: string | null;
  task_id: string | null;
  task_title: string | null;
  parent_session_id: string | null;
  best_match: {
    event_id: number | null;
    match_source: string;
    excerpt: string;
  };
  evidence: Array<{
    source: string;
    event_id: number | null;
    excerpt: string;
  }>;
  session_url: string;
}

export interface SearchStatus {
  search?: {
    status: "partial";
    stage: "lexical" | "semantic" | "navigation";
    reason: "timeout" | "cancelled";
  };
  query_expansion?: {
    status: "expanded" | "skipped" | "partial";
    reason?: "configuration" | "timeout" | "cancelled" | "model_error";
    latency_ms: number;
  };
  search_latency_ms?: number;
  db_cancel?: "failed";
}

export type SearchMatchSource =
  | "message"
  | "turn_summary"
  | "highlight"
  | "story";

export interface SearchFilters {
  searchSessionId: boolean;
  eventCategories: SearchEventCategory[] | null;
  includeTurnSummaries: boolean;
  includeHighlight: boolean;
  includeStory: boolean;
}

export const DEFAULT_SEARCH_FILTERS: SearchFilters = {
  searchSessionId: true,
  eventCategories: [...DEFAULT_SEARCH_CATEGORIES],
  includeTurnSummaries: false,
  includeHighlight: false,
  includeStory: false,
};

export type SearchNavigationResult =
  | {
    kind: "folder";
    id: string;
    title: string;
    folder_id: string;
    project_page_id: string;
  }
  | {
    kind: "task";
    id: string;
    title: string;
    folder_id: string;
    project_page_id: string;
    board_item_id: string;
    task_page_id: string;
  };

export function buildSessionSearchUrl(
  query: string,
  filters: SearchFilters,
  topK: number,
): string {
  const params = new URLSearchParams({
    q: query,
    top_k: String(topK),
    search_session_id: String(filters.searchSessionId),
  });
  params.set("include_session_results", "true");
  if (filters.eventCategories !== null) {
    params.set("event_categories", filters.eventCategories.join(","));
  }
  if (filters.includeTurnSummaries) {
    params.set("include_turn_summaries", "true");
  }
  if (filters.includeHighlight) {
    params.set("include_highlight", "true");
  }
  if (filters.includeStory) {
    params.set("include_story", "true");
  }
  return `/cogito/search?${params}`;
}

/** 검색이 나간 계기. 디바운스된 타건인지, 필터 변경인지, 명시적 제출인지. */
export type SearchTrigger = "typing" | "filter" | "submit";

export function useSessionSearch() {
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [navigationResults, setNavigationResults] =
    useState<SearchNavigationResult[]>([]);
  const [sessionResults, setSessionResults] = useState<SearchSessionResult[]>([]);
  const [searchStatus, setSearchStatus] = useState<SearchStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const searchSequence = useRef(0);
  // 사용 로그: 실제로 요청이 나간 검색만 센다. 타건 자체는 남기지 않는다.
  const trackUiEvent = useUiEventTracker();
  const searchFlowIdRef = useRef<string | null>(null);

  const search = useCallback(
    async (
      query: string,
      filters: SearchFilters = DEFAULT_SEARCH_FILTERS,
      topK = 20,
      trigger: SearchTrigger = "typing",
    ) => {
      if (!query.trim()) {
        abortRef.current?.abort();
        searchSequence.current += 1;
        setResults([]);
        setNavigationResults([]);
        setSessionResults([]);
        setSearchStatus(null);
        setLoading(false);
        return;
      }
      // 진행 중인 이전 요청 취소
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const sequence = ++searchSequence.current;

      const flowId = globalThis.crypto.randomUUID();
      searchFlowIdRef.current = flowId;
      const startedAt = Date.now();
      trackUiEvent("search_submit", {
        flowId,
        attrs: {
          queryText: query,
          trigger,
          searchSessionId: String(filters.searchSessionId),
        },
      });

      setLoading(true);
      setError(null);
      try {
        const res = await fetch(buildSessionSearchUrl(query, filters, topK), {
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.detail ?? `Search failed: ${res.status}`);
        }
        const data = await res.json();
        if (sequence !== searchSequence.current) return;
        setResults(data.results ?? []);
        setNavigationResults(data.navigation_results ?? []);
        setSessionResults(data.session_results ?? []);
        setSearchStatus(data.search_status ?? null);
        trackUiEvent("search_result", {
          flowId,
          attrs: {
            status: "ok",
            durationMs: Date.now() - startedAt,
            resultCount: (data.results?.length ?? 0)
              + (data.navigation_results?.length ?? 0)
              + (data.session_results?.length ?? 0),
          },
        });
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          // 다음 타건이 앞선 판정을 버린 경우. 버려진 검색도 사실이라 남긴다.
          trackUiEvent("search_result", {
            flowId,
            attrs: { status: "aborted", durationMs: Date.now() - startedAt },
          });
          return;
        }
        if (sequence !== searchSequence.current) return;
        trackUiEvent("search_result", {
          flowId,
          attrs: { status: "error", durationMs: Date.now() - startedAt },
        });
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (sequence === searchSequence.current) setLoading(false);
      }
    },
    [trackUiEvent],
  );

  const clear = useCallback(() => {
    setResults([]);
    setNavigationResults([]);
    setSessionResults([]);
    setSearchStatus(null);
    setError(null);
    setLoading(false);
    abortRef.current?.abort();
    searchSequence.current += 1;
  }, []);

  return {
    results,
    navigationResults,
    sessionResults,
    searchStatus,
    loading,
    error,
    search,
    clear,
    // 결과 선택 이벤트를 같은 검색에 묶기 위한 상관키.
    currentSearchFlowId: () => searchFlowIdRef.current,
  };
}
