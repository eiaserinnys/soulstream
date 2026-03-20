"""
test_search - BM25 전문 검색 테스트

1. extract_searchable_text: 6가지 이벤트 타입 커버
2. BM25SearchEngine: 빈 쿼리 에러, 검색 결과 정확도
"""

import pytest
from pathlib import Path

from soul_server.service.event_store import EventStore, extract_searchable_text
from soul_server.cogito.search import BM25SearchEngine, SearchResult


# ---------------------------------------------------------------------------
# extract_searchable_text 단위 테스트
# ---------------------------------------------------------------------------


class TestExtractSearchableText:
    def test_text_delta(self):
        event = {"type": "text_delta", "text": "안녕하세요"}
        assert extract_searchable_text(event) == "안녕하세요"

    def test_thinking(self):
        event = {"type": "thinking", "thinking": "이건 생각입니다"}
        assert extract_searchable_text(event) == "이건 생각입니다"

    def test_tool_use_string_input(self):
        event = {"type": "tool_use", "input": "파일을 읽어주세요"}
        assert extract_searchable_text(event) == "파일을 읽어주세요"

    def test_tool_use_dict_input(self):
        event = {"type": "tool_use", "input": {"path": "/foo/bar.py"}}
        result = extract_searchable_text(event)
        assert result is not None
        assert "foo" in result or "bar" in result

    def test_tool_result_string(self):
        event = {"type": "tool_result", "content": "결과 텍스트"}
        assert extract_searchable_text(event) == "결과 텍스트"

    def test_tool_result_list(self):
        event = {
            "type": "tool_result",
            "content": [
                {"type": "text", "text": "첫 번째"},
                {"type": "text", "text": "두 번째"},
            ],
        }
        result = extract_searchable_text(event)
        assert "첫 번째" in result
        assert "두 번째" in result

    def test_user_string(self):
        event = {"type": "user", "content": "사용자 메시지"}
        assert extract_searchable_text(event) == "사용자 메시지"

    def test_user_list(self):
        event = {
            "type": "user",
            "content": [
                {"type": "text", "text": "텍스트 블록"},
            ],
        }
        assert extract_searchable_text(event) == "텍스트 블록"

    def test_unknown_type_returns_none(self):
        event = {"type": "session_start", "data": "something"}
        assert extract_searchable_text(event) is None

    def test_text_delta_missing_text(self):
        event = {"type": "text_delta"}
        assert extract_searchable_text(event) is None

    def test_thinking_missing_field(self):
        event = {"type": "thinking"}
        assert extract_searchable_text(event) is None


# ---------------------------------------------------------------------------
# BM25SearchEngine 단위 테스트
# ---------------------------------------------------------------------------


@pytest.fixture
def store_with_events(tmp_path):
    """3개 이벤트가 담긴 EventStore 픽스처"""
    store = EventStore(base_dir=tmp_path)
    store.append(
        "session-a",
        {"type": "user", "content": "BM25 검색 기능을 구현해주세요"},
    )
    store.append(
        "session-a",
        {"type": "text_delta", "text": "BM25 알고리즘은 Okapi BM25라고도 불립니다"},
    )
    store.append(
        "session-b",
        {"type": "user", "content": "전혀 다른 주제의 메시지입니다"},
    )
    return store


class TestBM25SearchEngine:
    def test_empty_query_raises(self, store_with_events):
        engine = BM25SearchEngine(store_with_events)
        with pytest.raises(ValueError, match="query must not be empty"):
            engine.search(query="   ")

    def test_no_docs_returns_empty(self, tmp_path):
        empty_store = EventStore(base_dir=tmp_path)
        engine = BM25SearchEngine(empty_store)
        results = engine.search(query="검색어")
        assert results == []

    def test_search_returns_relevant_results(self, store_with_events):
        engine = BM25SearchEngine(store_with_events)
        results = engine.search(query="BM25")
        assert len(results) > 0
        # BM25가 포함된 이벤트가 상위에 있어야 한다
        assert any("BM25" in r.preview or "bm25" in r.preview.lower() for r in results)

    def test_search_result_fields(self, store_with_events):
        engine = BM25SearchEngine(store_with_events)
        results = engine.search(query="BM25")
        assert len(results) > 0
        r = results[0]
        assert isinstance(r, SearchResult)
        assert r.session_id in ("session-a", "session-b")
        assert isinstance(r.event_id, int)
        assert r.score > 0
        assert isinstance(r.preview, str)
        assert r.event_type in ("user", "text_delta", "thinking", "tool_use", "tool_result")

    def test_search_score_positive_only(self, store_with_events):
        engine = BM25SearchEngine(store_with_events)
        results = engine.search(query="BM25")
        assert all(r.score > 0 for r in results)

    def test_search_with_session_ids_filter(self, store_with_events):
        engine = BM25SearchEngine(store_with_events)
        results = engine.search(query="BM25", session_ids=["session-a"])
        assert all(r.session_id == "session-a" for r in results)

    def test_top_k_limit(self, store_with_events):
        engine = BM25SearchEngine(store_with_events)
        results = engine.search(query="BM25", top_k=1)
        assert len(results) <= 1

    def test_top_k_capped_at_100(self, tmp_path):
        store = EventStore(base_dir=tmp_path)
        for i in range(5):
            store.append(f"sess-{i}", {"type": "user", "content": f"검색 테스트 {i}"})
        engine = BM25SearchEngine(store)
        results = engine.search(query="검색", top_k=200)
        # top_k가 100으로 캡핑되어도 실제 문서 수(5)가 적으므로 최대 5개
        assert len(results) <= 5

    def test_preview_truncated_at_200(self, tmp_path):
        store = EventStore(base_dir=tmp_path)
        long_text = "긴 텍스트 " * 100  # 600자 이상
        store.append("sess-long", {"type": "user", "content": long_text})
        # BM25Okapi IDF = log((N - df + 0.5) / (df + 0.5))
        # df=1일 때 N >= 3이면 양수가 된다: log((3-1+0.5)/(1+0.5)) = log(1.667) > 0
        store.append("sess-other1", {"type": "user", "content": "전혀 다른 내용"})
        store.append("sess-other2", {"type": "user", "content": "또 다른 내용"})
        engine = BM25SearchEngine(store)
        results = engine.search(query="긴 텍스트")
        assert len(results) > 0
        # preview는 200자 + "..." 형태이므로 최대 203자
        assert len(results[0].preview) <= 203
        assert results[0].preview.endswith("...")
