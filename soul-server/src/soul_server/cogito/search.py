"""BM25 기반 세션 이벤트 전문 검색 엔진."""

from dataclasses import asdict, dataclass

from rank_bm25 import BM25Okapi

from soul_server.service.event_store import EventStore, extract_searchable_text


@dataclass
class SearchResult:
    session_id: str
    event_id: int
    score: float
    preview: str  # 최대 200자
    event_type: str

    def to_dict(self) -> dict:
        return asdict(self)


class BM25SearchEngine:
    """BM25 전문 검색 엔진.

    온-더-플라이 인덱싱: search() 호출마다 대상 세션의 JSONL을 전부 읽어
    BM25 인덱스를 처음부터 구축한다. 세션 수 × 이벤트 수에 비례하는
    O(N) 시간 복잡도를 가지므로, 세션이 수백 개를 넘으면 응답 지연이 발생할 수 있다.
    인덱스 캐싱은 향후 확장 포인트로 남겨둔다.
    """

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
