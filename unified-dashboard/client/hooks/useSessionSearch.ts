/**
 * useSessionSearch - 세션 기록 BM25 전문 검색 hook (unified-dashboard)
 *
 * /cogito/search 엔드포인트를 호출하여 세션 이벤트를 검색합니다.
 * soul-dashboard의 useSessionSearch.ts에서 포팅.
 * orch의 /cogito/search가 공유 PostgreSQL을 직접 조회합니다.
 */

import { useState, useCallback, useRef } from "react";
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

export function useSessionSearch() {
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [navigationResults, setNavigationResults] =
    useState<SearchNavigationResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | undefined>(undefined);

  const search = useCallback(
    async (query: string, filters: SearchFilters = DEFAULT_SEARCH_FILTERS, topK = 20) => {
      if (!query.trim()) {
        setResults([]);
        setNavigationResults([]);
        return;
      }
      // 진행 중인 이전 요청 취소
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

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
        setResults(data.results ?? []);
        setNavigationResults(data.navigation_results ?? []);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const clear = useCallback(() => {
    setResults([]);
    setNavigationResults([]);
    setError(null);
  }, []);

  return { results, navigationResults, loading, error, search, clear };
}
