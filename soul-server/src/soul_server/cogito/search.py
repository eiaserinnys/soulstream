"""BM25 기반 세션 이벤트 전문 검색 엔진."""

from dataclasses import dataclass

from rank_bm25 import BM25Okapi

from soul_server.service.event_store import EventStore, extract_searchable_text


@dataclass
class SearchResult:
    session_id: str
    event_id: int
    score: float
    preview: str  # 최대 200자
    event_type: str


class BM25SearchEngine:
    def __init__(self, event_store: EventStore) -> None:
        self._store = event_store

    def search(
        self,
        query: str,
        session_ids: list[str] | None = None,
        top_k: int = 10,
    ) -> list[SearchResult]:
        if not query.strip():
            raise ValueError("query must not be empty")
        top_k = min(top_k, 100)
        target_sessions = session_ids or self._store.list_session_ids()
        docs: list[tuple[str, int, str, str]] = []  # (session_id, event_id, text, event_type)
        for sid in target_sessions:
            for entry in self._store.read_all(sid):
                ev = entry["event"]
                text = extract_searchable_text(ev)
                if text:
                    docs.append((sid, entry["id"], text, ev.get("type", "")))
        if not docs:
            return []
        tokenized = [d[2].lower().split() for d in docs]
        bm25 = BM25Okapi(tokenized)
        scores = bm25.get_scores(query.lower().split())
        ranked = sorted(
            zip(scores, docs), key=lambda x: x[0], reverse=True
        )[:top_k]
        results = []
        for score, (sid, eid, text, etype) in ranked:
            if score <= 0:
                continue
            preview = text[:200] + ("..." if len(text) > 200 else "")
            results.append(SearchResult(
                session_id=sid,
                event_id=eid,
                score=round(float(score), 4),
                preview=preview,
                event_type=etype,
            ))
        return results
