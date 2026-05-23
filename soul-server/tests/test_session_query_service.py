"""SessionQueryService.read_viewport / read_messages / stream_session_list_events 단위 테스트.

본 카드(2026-05-05 session-query-mirror-dedupe)에서 추가되는 service 메서드 3개 +
InvalidViewportRangeError 도메인 예외에 대한 RED→GREEN 사이클 테스트.

검증 항목:
- read_viewport: db.read_viewport + db.read_total_subtree_height 위임, dict 반환
- read_viewport: y_min > y_max → InvalidViewportRangeError raise
- read_messages: db.read_messages 위임, dict 반환 ({"messages", "next_cursor"})
- read_timeline: db.read_timeline 위임, dict 반환 ({"messages", "next_cursor"})
- stream_session_list_events: AsyncGenerator, 첫 yield session_list,
  broadcaster sentinel(None) → break, timeout → keepalive,
  finally remove_client 호출
- stream_session_list_events: limit 인자가 get_all_sessions에 전달

Mock 패턴: PostgresSessionDB.__new__()로 init 우회 후 메서드를 AsyncMock으로 부착
(test_viewport_api.py L329-332 기존 패턴 차용).
"""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from soul_server.service.postgres_session_db import PostgresSessionDB
from soul_server.service.session_query_service import (
    InvalidViewportRangeError,
    SessionQueryService,
)


# === Helpers ===

def _make_service(*, sessions=None, total=0):
    """SessionQueryService 인스턴스를 mock DB와 함께 생성한다.

    sessions/total은 _build_session_dict가 처리할 수 있는 row 형태가 아니라,
    self._db.get_all_sessions이 직접 반환하는 (rows, total) 형태여야 한다.
    """
    db = AsyncMock(spec=PostgresSessionDB)
    db.read_viewport = AsyncMock()
    db.read_total_subtree_height = AsyncMock()
    db.read_messages = AsyncMock()
    db.read_timeline = AsyncMock()
    db.get_all_sessions = AsyncMock(return_value=(sessions or [], total))
    db.get_all_folders = AsyncMock(return_value=[])
    tasks: dict = {}
    return SessionQueryService(db, tasks), db


# === read_viewport ===

class TestReadViewport:
    @pytest.mark.asyncio
    async def test_returns_events_and_total(self):
        service, db = _make_service()
        db.read_viewport.return_value = [
            {"id": 1, "y_start": 1, "y_end": 5, "event_type": "user_message"},
        ]
        db.read_total_subtree_height.return_value = 100

        result = await service.read_viewport("sess-1", 1, 50)

        assert result == {
            "events": [
                {"id": 1, "y_start": 1, "y_end": 5, "event_type": "user_message"},
            ],
            "total_subtree_height": 100,
        }
        db.read_viewport.assert_awaited_once_with("sess-1", 1, 50)
        db.read_total_subtree_height.assert_awaited_once_with("sess-1")

    @pytest.mark.asyncio
    async def test_invalid_range_raises(self):
        service, db = _make_service()

        with pytest.raises(InvalidViewportRangeError) as exc_info:
            await service.read_viewport("sess-1", 50, 1)

        assert exc_info.value.y_min == 50
        assert exc_info.value.y_max == 1
        assert "y_min (50) must be <= y_max (1)" in str(exc_info.value)
        # db는 호출되지 않아야 함 (검증이 service에서 응집)
        db.read_viewport.assert_not_awaited()
        db.read_total_subtree_height.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_equal_range_allowed(self):
        """y_min == y_max는 유효한 viewport (1행 조회)."""
        service, db = _make_service()
        db.read_viewport.return_value = []
        db.read_total_subtree_height.return_value = 0

        result = await service.read_viewport("sess-1", 10, 10)

        assert result == {"events": [], "total_subtree_height": 0}
        db.read_viewport.assert_awaited_once_with("sess-1", 10, 10)


# === read_messages ===

class TestReadMessages:
    @pytest.mark.asyncio
    async def test_returns_messages_and_cursor(self):
        service, db = _make_service()
        db.read_messages.return_value = (
            [{"id": 5, "event_type": "user_message"}],
            "2026-05-05T10:00:00+00:00",
        )

        result = await service.read_messages("sess-1", before=None, limit=50)

        assert result == {
            "messages": [{"id": 5, "event_type": "user_message"}],
            "next_cursor": "2026-05-05T10:00:00+00:00",
        }
        db.read_messages.assert_awaited_once_with("sess-1", before=None, limit=50)

    @pytest.mark.asyncio
    async def test_passes_before_and_limit(self):
        service, db = _make_service()
        db.read_messages.return_value = ([], None)

        await service.read_messages("sess-1", before="2026-05-05T09:00:00+00:00", limit=10)

        db.read_messages.assert_awaited_once_with(
            "sess-1", before="2026-05-05T09:00:00+00:00", limit=10,
        )

    @pytest.mark.asyncio
    async def test_default_limit_50(self):
        """limit 미지정 시 기본 50."""
        service, db = _make_service()
        db.read_messages.return_value = ([], None)

        await service.read_messages("sess-1")

        db.read_messages.assert_awaited_once_with("sess-1", before=None, limit=50)

    @pytest.mark.asyncio
    async def test_returns_none_cursor(self):
        """next_cursor가 None인 경우 그대로 전달."""
        service, db = _make_service()
        db.read_messages.return_value = ([], None)

        result = await service.read_messages("sess-1")

        assert result == {"messages": [], "next_cursor": None}


# === read_timeline ===

class TestReadTimeline:
    @pytest.mark.asyncio
    async def test_returns_messages_and_cursor(self):
        service, db = _make_service()
        db.read_timeline.return_value = (
            [{"id": 5, "event_type": "assistant_message"}],
            "2026-05-05T10:00:00+00:00,5",
        )

        result = await service.read_timeline("sess-1", before=None, limit=50)

        assert result == {
            "messages": [{"id": 5, "event_type": "assistant_message"}],
            "next_cursor": "2026-05-05T10:00:00+00:00,5",
        }
        db.read_timeline.assert_awaited_once_with("sess-1", before=None, limit=50)

    @pytest.mark.asyncio
    async def test_passes_before_and_limit(self):
        service, db = _make_service()
        db.read_timeline.return_value = ([], None)

        await service.read_timeline(
            "sess-1",
            before="2026-05-05T09:00:00+00:00,7",
            limit=10,
        )

        db.read_timeline.assert_awaited_once_with(
            "sess-1", before="2026-05-05T09:00:00+00:00,7", limit=10,
        )


# === stream_session_list_events ===

class FakeSessionBroadcaster:
    """get_session_broadcaster()의 반환을 흉내내는 fake."""

    def __init__(self):
        self.queue: asyncio.Queue = asyncio.Queue()
        self.added = False
        self.removed_with: list = []

    def add_client(self) -> asyncio.Queue:
        self.added = True
        return self.queue

    def remove_client(self, q: asyncio.Queue) -> None:
        self.removed_with.append(q)


@pytest.fixture
def fake_broadcaster(monkeypatch):
    """get_session_broadcaster를 lazy import하므로 module attribute를 patch."""
    fake = FakeSessionBroadcaster()
    import soul_server.service.session_broadcaster as broadcaster_module

    monkeypatch.setattr(
        broadcaster_module, "get_session_broadcaster", lambda: fake,
    )
    return fake


class TestStreamSessionListEvents:
    @pytest.mark.asyncio
    async def test_initial_session_list_event(self, fake_broadcaster):
        service, db = _make_service(sessions=[], total=0)
        gen = service.stream_session_list_events()

        first = await gen.__anext__()
        # broadcaster sentinel을 보내 generator 종료
        fake_broadcaster.queue.put_nowait(None)
        # 종료 흐름까지 진행
        with pytest.raises(StopAsyncIteration):
            await gen.__anext__()

        assert first["event"] == "session_list"
        payload = json.loads(first["data"])
        assert payload["type"] == "session_list"
        assert payload["sessions"] == []
        assert payload["total"] == 0
        # add_client + remove_client 모두 호출
        assert fake_broadcaster.added is True
        assert fake_broadcaster.queue in fake_broadcaster.removed_with

    @pytest.mark.asyncio
    async def test_default_limit_zero_passed_to_get_all_sessions(self, fake_broadcaster):
        """limit 미지정 시 service.get_all_sessions(offset=0, limit=0) 호출 (전체 조회)."""
        service, db = _make_service(sessions=[], total=0)
        gen = service.stream_session_list_events()

        await gen.__anext__()
        fake_broadcaster.queue.put_nowait(None)
        with pytest.raises(StopAsyncIteration):
            await gen.__anext__()

        db.get_all_sessions.assert_awaited_once_with(
            offset=0, limit=0, session_type=None, folder_id=None,
            node_id=None, status=None, feed_only=False,
        )

    @pytest.mark.asyncio
    async def test_limit_kwarg_passed_to_get_all_sessions(self, fake_broadcaster):
        """limit=50 지정 시 get_all_sessions(offset=0, limit=50) 호출."""
        service, db = _make_service(sessions=[], total=0)
        gen = service.stream_session_list_events(limit=50)

        await gen.__anext__()
        fake_broadcaster.queue.put_nowait(None)
        with pytest.raises(StopAsyncIteration):
            await gen.__anext__()

        db.get_all_sessions.assert_awaited_once_with(
            offset=0, limit=50, session_type=None, folder_id=None,
            node_id=None, status=None, feed_only=False,
        )

    @pytest.mark.asyncio
    async def test_broadcasts_event_payloads(self, fake_broadcaster):
        """broadcaster에서 받은 (eid, event)는 SSE dict로 yield된다."""
        service, db = _make_service(sessions=[], total=0)
        gen = service.stream_session_list_events()

        # 초기 session_list
        await gen.__anext__()
        # 이벤트 한 건 전달
        fake_broadcaster.queue.put_nowait((42, {"type": "session_created", "id": "abc"}))
        sse = await gen.__anext__()
        # 종료
        fake_broadcaster.queue.put_nowait(None)
        with pytest.raises(StopAsyncIteration):
            await gen.__anext__()

        assert sse["event"] == "session_created"
        payload = json.loads(sse["data"])
        assert payload["type"] == "session_created"
        assert payload["id"] == "abc"

    @pytest.mark.asyncio
    async def test_keepalive_on_timeout(self, fake_broadcaster, monkeypatch):
        """asyncio.wait_for가 TimeoutError를 던지면 keepalive comment yield."""
        service, db = _make_service(sessions=[], total=0)

        # asyncio.wait_for를 timeout 발생 후 한 번만 sentinel을 반환하도록 패치
        call_count = {"n": 0}

        async def fake_wait_for(awaitable, timeout):
            # 들어온 awaitable(queue.get())을 닫아서 자원 누수 방지
            try:
                awaitable.close()  # type: ignore[attr-defined]
            except Exception:
                pass
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise asyncio.TimeoutError
            return None  # 두 번째 호출은 sentinel(None) → break

        import soul_server.service.session_query_service as svc_mod
        monkeypatch.setattr(svc_mod.asyncio, "wait_for", fake_wait_for)

        gen = service.stream_session_list_events()
        await gen.__anext__()  # session_list
        keepalive = await gen.__anext__()
        assert keepalive == {"comment": "keepalive"}
        # 다음은 sentinel로 종료
        with pytest.raises(StopAsyncIteration):
            await gen.__anext__()

    @pytest.mark.asyncio
    async def test_finally_removes_client_on_aclose_mid_loop(self, fake_broadcaster):
        """loop 진입 후 aclose하면 finally에서 remove_client 호출.

        주의: 기존 라우터 코드와 동일하게 add_client는 첫 yield(session_list)
        *이후*에 호출된다. 따라서 첫 yield 직후 aclose하면 add_client도
        호출되지 않은 상태이므로 remove_client도 호출되지 않는 것이 정상이다.
        본 테스트는 broadcaster 이벤트 1건 처리 후(=add_client가 이미 호출된
        상태)에서 aclose가 finally를 실행함을 검증한다.
        """
        service, db = _make_service(sessions=[], total=0)
        gen = service.stream_session_list_events()

        # 1) session_list yield (add_client 아직 호출 전)
        await gen.__anext__()
        # 2) broadcaster 이벤트 전달 → add_client 호출 후 SSE event yield
        fake_broadcaster.queue.put_nowait((1, {"type": "session_created"}))
        await gen.__anext__()
        # 3) 이 시점에는 add_client 완료 + try 진입 → aclose가 finally 실행
        await gen.aclose()

        assert fake_broadcaster.added is True
        assert fake_broadcaster.queue in fake_broadcaster.removed_with


# === _build_session_dict caller_info 추출 (R-3 fix) ===

class TestBuildSessionDictCallerInfo:
    """_build_session_dict가 row.metadata의 caller_info를 userName/userPortraitUrl로
    추출하는지 검증한다.

    R-3 fix(2026-05-08): dashboard /api/sessions 응답이 caller_info 정체성을 무시하고
    settings.dash_user_name 일괄 덮어쓰기로 표시되던 결함을 닫는 첫 단계.
    DB row → API dict 변환 시점에 caller_info를 추출하여, dashboard 라우트의 헬퍼가
    mix-fallback 금지 정책을 적용할 수 있게 한다.

    orch `_session_to_response`(session_serializer.py)와 동일 추출 패턴.
    """

    def test_caller_info_with_display_name_fills_userName(self):
        """metadata에 caller_info display_name 있음 → info["userName"] 채움."""
        from soul_server.service.session_query_service import _build_session_dict

        row = {
            "session_id": "s1",
            "status": "running",
            "prompt": "hi",
            "created_at": None,
            "metadata": [
                {"type": "caller_info", "value": {"display_name": "Alice", "source": "browser"}}
            ],
        }
        info = _build_session_dict(row, task=None, registry=None)
        assert info["userName"] == "Alice"

    def test_caller_info_with_avatar_url_fills_userPortraitUrl(self):
        """metadata에 caller_info avatar_url 있음 → info["userPortraitUrl"] 채움."""
        from soul_server.service.session_query_service import _build_session_dict

        row = {
            "session_id": "s1",
            "status": "running",
            "prompt": "hi",
            "created_at": None,
            "metadata": [
                {
                    "type": "caller_info",
                    "value": {
                        "display_name": "Alice",
                        "avatar_url": "https://avatars.slack.com/u123",
                        "source": "slack",
                    },
                }
            ],
        }
        info = _build_session_dict(row, task=None, registry=None)
        assert info["userName"] == "Alice"
        assert info["userPortraitUrl"] == "https://avatars.slack.com/u123"

    def test_caller_info_absent_no_user_keys(self):
        """metadata에 caller_info 없음 → info에 userName/userPortraitUrl 키 없음 (또는 None).

        dashboard 라우트의 헬퍼가 graceful하게 fallback하도록, 키 부재 또는 None 둘 다 허용.
        """
        from soul_server.service.session_query_service import _build_session_dict

        row = {
            "session_id": "s1",
            "status": "running",
            "prompt": "hi",
            "created_at": None,
            "metadata": [],
        }
        info = _build_session_dict(row, task=None, registry=None)
        assert not info.get("userName")
        assert not info.get("userPortraitUrl")

    def test_caller_info_with_only_display_name_no_portrait(self):
        """display_name만 있고 avatar_url 없음 → userName만 채움."""
        from soul_server.service.session_query_service import _build_session_dict

        row = {
            "session_id": "s1",
            "status": "running",
            "prompt": "hi",
            "created_at": None,
            "metadata": [
                {"type": "caller_info", "value": {"display_name": "Alice"}}
            ],
        }
        info = _build_session_dict(row, task=None, registry=None)
        assert info["userName"] == "Alice"
        assert not info.get("userPortraitUrl")

    def test_caller_info_empty_strings_treated_as_absent(self):
        """display_name 빈 문자열 → 채움 안 함 (isinstance + truthy 가드)."""
        from soul_server.service.session_query_service import _build_session_dict

        row = {
            "session_id": "s1",
            "status": "running",
            "prompt": "hi",
            "created_at": None,
            "metadata": [
                {"type": "caller_info", "value": {"display_name": "", "avatar_url": ""}}
            ],
        }
        info = _build_session_dict(row, task=None, registry=None)
        assert not info.get("userName")
        assert not info.get("userPortraitUrl")
