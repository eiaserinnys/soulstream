/**
 * useSessionSearch - 세션 기록 BM25 전문 검색 hook (unified-dashboard)
 *
 * /cogito/search 엔드포인트를 호출하여 세션 이벤트를 검색합니다.
 * soul-dashboard의 useSessionSearch.ts에서 포팅.
 * 경로 변경: /api/cogito/search → /cogito/search
 * (soul-server에서 cogito 라우터는 /api 프리픽스 없이 마운트됨. BFF 없음)
 */

import { useState, useCallback, useRef } from "react";

export interface SearchResultItem {
  session_id: string;
  event_id: number;
  score: number;
  preview: string;
  event_type: string;
}

export function useSessionSearch() {
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | undefined>(undefined);

  const search = useCallback(async (query: string, topK = 20) => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    // 진행 중인 이전 요청 취소
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ q: query, top_k: String(topK) });
      const res = await fetch(`/cogito/search?${params}`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? `Search failed: ${res.status}`);
      }
      const data = await res.json();
      setResults(data.results ?? []);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const clear = useCallback(() => {
    setResults([]);
    setError(null);
  }, []);

  return { results, loading, error, search, clear };
}
