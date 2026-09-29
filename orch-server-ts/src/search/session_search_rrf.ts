import type { SessionDocumentCard } from "./session_document_search_index.js";

export type SessionSearchPoolResult = Record<string, unknown> & {
  readonly session_id: string;
  readonly updated_at: string | null;
  readonly title: string;
};

export type SessionSearchPoolCandidate = {
  readonly session_id: string;
  readonly updated_at: string | null;
  readonly result: SessionSearchPoolResult;
  readonly card: SessionDocumentCard;
  readonly rrf_score: number;
};

export function filterTitleResultsToIndexedSessions<T extends { readonly session_id: string }>(
  titleResults: readonly T[],
  hasSession: (sessionId: string) => boolean,
): T[] {
  return titleResults.filter((result) => hasSession(result.session_id));
}

export function buildSessionSearchRrfPool(
  titleResults: readonly SessionSearchPoolResult[],
  documentResults: readonly SessionSearchPoolResult[],
  cardForSession: (sessionId: string) => SessionDocumentCard,
  limit = 50,
): SessionSearchPoolCandidate[] {
  const pool = new Map<string, SessionSearchPoolCandidate>();
  const add = (rows: readonly SessionSearchPoolResult[]) => {
    rows.forEach((result, index) => {
      const rank = index + 1;
      const current = pool.get(result.session_id);
      pool.set(result.session_id, {
        session_id: result.session_id,
        updated_at: result.updated_at ?? current?.updated_at ?? null,
        result: current?.result ?? result,
        card: cardForSession(result.session_id),
        rrf_score: (current?.rrf_score ?? 0) + 1 / (60 + rank),
      });
    });
  };
  add(titleResults);
  add(documentResults);
  return [...pool.values()]
    .sort((left, right) => right.rrf_score - left.rrf_score
      || (right.updated_at ?? "").localeCompare(left.updated_at ?? "")
      || left.session_id.localeCompare(right.session_id))
    .slice(0, limit);
}

export function orderSessionSearchResults<T extends { readonly session_id: string }>(
  pool: readonly T[],
  relevanceBySession: ReadonlyMap<string, number> | null,
): Array<T & { readonly relevance: number | null }> {
  if (relevanceBySession === null) return pool.map((item) => ({ ...item, relevance: null }));
  const ordered = pool
    .map((item, index) => ({ ...item, relevance: relevanceBySession.get(item.session_id) ?? null, index }))
    .sort((left, right) => (right.relevance ?? -1) - (left.relevance ?? -1) || left.index - right.index);
  return ordered.map((item) => {
    const { index: _index, ...result } = item;
    return result as T & { readonly relevance: number | null };
  });
}
