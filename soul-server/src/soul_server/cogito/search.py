"""FTS5 기반 세션 이벤트 전문 검색 엔진."""

import json
from dataclasses import asdict, dataclass

from soul_server.service.session_db import SessionDB


@dataclass
class SearchResult:
    session_id: str
    event_id: int
    score: float
    preview: str  # 최대 200자
    event_type: str

    def to_dict(self) -> dict:
        return asdict(self)


class SessionSearchEngine:
    """FTS5 전문 검색 엔진.

    SQLite FTS5 내장 검색을 사용하여 on-the-fly 인덱싱 없이 검색한다.
    """

    def __init__(self, session_db: SessionDB) -> None:
        self._db = session_db

    def search(
        self,
        query: str,
        session_ids: list[str] | None = None,
        top_k: int = 10,
    ) -> list[SearchResult]:
        if not query.strip():
            raise ValueError("query must not be empty")
        top_k = min(top_k, 100)
        results = self._db.search_events(query, session_ids=session_ids, limit=top_k)
        search_results = []
        for r in results:
            text = r.get("searchable_text", "")
            preview = text[:200] + ("..." if len(text) > 200 else "")
            search_results.append(SearchResult(
                session_id=r["session_id"],
                event_id=r["id"],
                score=0.0,  # FTS5 rank는 내부 점수, BM25 score와 호환 불필요
                preview=preview,
                event_type=r.get("event_type", ""),
            ))
        return search_results


# Backward-compatible alias
BM25SearchEngine = SessionSearchEngine
