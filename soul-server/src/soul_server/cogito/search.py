"""tsvector 기반 세션 이벤트 전문 검색 엔진."""

import json
from dataclasses import asdict, dataclass

from soul_server.service.postgres_session_db import PostgresSessionDB


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
    """tsvector 전문 검색 엔진.

    PostgreSQL tsvector 내장 검색을 사용하여 on-the-fly 인덱싱 없이 검색한다.
    """

    def __init__(self, session_db: PostgresSessionDB) -> None:
        self._db = session_db

    async def search(
        self,
        query: str,
        session_ids: list[str] | None = None,
        top_k: int = 10,
        event_types: list[str] | None = None,
        search_session_id: bool = False,
    ) -> list[SearchResult]:
        """세션 이벤트를 검색한다.

        event_types와 search_session_id는 배타적이 아닌 가산적(OR 합산)이다.
        - event_types 지정 또는 search_session_id=False → text search 수행
        - search_session_id=True → session_id ILIKE 검색을 추가로 수행
        - 두 결과를 중복 제거 후 score 내림차순 정렬, top_k 반환

        Args:
            query: 검색어
            session_ids: 검색 범위를 특정 세션으로 한정 (text search 전용)
            top_k: 반환할 최대 결과 수 (최대 100)
            event_types: 검색할 이벤트 타입 목록. None이면 전체 타입
            search_session_id: True이면 session_id ILIKE 검색을 추가로 수행
        """
        if not query.strip():
            raise ValueError("query must not be empty")
        top_k = min(top_k, 100)

        raw: list[dict] = []
        seen: set[tuple] = set()

        # 텍스트 검색: event_types 지정 시 또는 session_id 검색을 사용하지 않을 때
        if event_types or not search_session_id:
            text_rows = await self._db.search_events(
                query, session_ids=session_ids, limit=top_k, event_types=event_types
            )
            for r in text_rows:
                key = (r["session_id"], r["id"])
                if key not in seen:
                    seen.add(key)
                    raw.append(r)

        # 세션 아이디 검색: 추가적으로 실행 (OR 합산)
        if search_session_id:
            sid_rows = await self._db.search_events_by_session_id(
                query, event_types=event_types, limit=top_k
            )
            for r in sid_rows:
                key = (r["session_id"], r["id"])
                if key not in seen:
                    seen.add(key)
                    raw.append(r)

        raw.sort(key=lambda x: x.get("score", 0.0), reverse=True)
        raw = raw[:top_k]

        search_results = []
        for r in raw:
            text = r.get("searchable_text", "")
            preview = text[:200] + ("..." if len(text) > 200 else "")
            search_results.append(SearchResult(
                session_id=r["session_id"],
                event_id=r["id"],
                score=r.get("score", 0.0),
                preview=preview,
                event_type=r.get("event_type", ""),
            ))
        return search_results


# Backward-compatible alias
BM25SearchEngine = SessionSearchEngine
