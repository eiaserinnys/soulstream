"""Tests for Sessions SSE stream (/api/sessions/stream).

Validates the SSE endpoint that the soul-ui useSessionListProvider expects:
- Initial session_list event on connect
- Relays broadcaster events (session_created, session_deleted, etc.)
- Phase 2: Last-Event-ID resume — stream_meta/replay/replay_gap
"""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from soulstream_server.api.session_serializer import _session_to_response
from soulstream_server.api.sessions import create_sessions_router
from soulstream_server.service.session_broadcaster import SessionBroadcaster


def _get_stream_route(router):
    """SSE /stream 라우트 endpoint 추출.

    APIRouter(prefix="/api/sessions") + @router.get("/stream")이면
    실제 등록 path는 "/api/sessions/stream"이다.
    """
    return next(
        r for r in router.routes
        if getattr(r, "path", "") == "/api/sessions/stream"
    )


def _make_request_mock(headers: dict | None = None, query: dict | None = None) -> MagicMock:
    """session_stream이 사용하는 Request의 최소 mock.

    - headers.get(name) — Last-Event-ID 헤더는 lower-case로 access
    - query_params.get(name) — lastEventId, instanceId
    - is_disconnected() — 큐 구독 루프 차단용 (기본 False, 호출 시 True 반환 가능)
    """
    request = MagicMock()
    request.headers = headers or {}
    request.query_params = query or {}
    request.is_disconnected = AsyncMock(return_value=False)
    return request


async def _collect_n_events(gen, n: int, *, timeout_per_step: float = 1.0):
    """generator에서 최대 n개 이벤트를 수집한다.

    finally + aclose로 generator 정리. keepalive(comment-only)도 카운트.
    """
    events = []
    try:
        for _ in range(n):
            try:
                event = await asyncio.wait_for(gen.__anext__(), timeout=timeout_per_step)
            except (asyncio.TimeoutError, StopAsyncIteration):
                break
            events.append(event)
    finally:
        await gen.aclose()
    return events


async def _collect_until_disconnect(gen, *, max_events: int = 10, timeout_per_step: float = 1.0):
    """generator에서 disconnect/StopAsyncIteration까지 수집.

    keepalive comment는 stop 신호로 사용. (큐 구독 루프 timeout=30 wait_for를 회피하기
    위해 호출자가 사전에 is_disconnected를 True로 만들어두는 패턴 권장.)
    """
    events = []
    try:
        for _ in range(max_events):
            try:
                event = await asyncio.wait_for(gen.__anext__(), timeout=timeout_per_step)
            except (asyncio.TimeoutError, StopAsyncIteration):
                break
            events.append(event)
    finally:
        await gen.aclose()
    return events


class TestSessionToResponseFormat:
    """_session_to_response output matches what session_list SSE sends."""

    async def test_response_has_camelcase_fields(self):
        """Converted session has camelCase field names."""
        session = {
            "session_id": "s1",
            "status": "running",
            "prompt": "hello",
            "created_at": "2026-01-01T00:00:00",
            "updated_at": None,
            "session_type": "claude",
            "last_message": "test msg",
            "client_id": "c1",
            "metadata": None,
            "display_name": "My Session",
            "node_id": "n1",
            "folder_id": "f1",
        }

        result = _session_to_response(session)

        assert result["agentSessionId"] == "s1"
        assert result["status"] == "running"
        assert result["prompt"] == "hello"
        assert result["createdAt"] == "2026-01-01T00:00:00"
        assert result["updatedAt"] is None
        assert result["sessionType"] == "claude"
        assert result["lastMessage"] == "test msg"
        assert result["clientId"] == "c1"
        assert result["displayName"] == "My Session"
        assert result["nodeId"] == "n1"
        assert result["folderId"] == "f1"

    async def test_datetime_objects_converted_to_isoformat(self):
        """datetime objects in created_at/updated_at are converted to ISO strings."""
        from datetime import datetime, timezone

        now = datetime(2026, 3, 25, 12, 0, 0, tzinfo=timezone.utc)
        session = {
            "session_id": "s1",
            "status": "running",
            "created_at": now,
            "updated_at": now,
        }

        result = _session_to_response(session)
        assert result["createdAt"] == "2026-03-25T12:00:00+00:00"
        assert result["updatedAt"] == "2026-03-25T12:00:00+00:00"


class TestSessionStreamBroadcasterIntegration:
    """Broadcaster events are relayed through the sessions stream."""

    async def test_add_client_registers_queue(self):
        """add_client() adds a queue to the broadcaster."""
        broadcaster = SessionBroadcaster()

        queue = broadcaster.add_client()

        await broadcaster.broadcast({"type": "session_created", "session": {}})
        _eid, event = queue.get_nowait()
        assert event["type"] == "session_created"

        broadcaster.remove_client(queue)

    async def test_session_deleted_event_format(self):
        """session_deleted events have the expected format."""
        broadcaster = SessionBroadcaster()
        queue = broadcaster.add_client()

        await broadcaster.emit_session_deleted("sess-42")

        _eid, event = queue.get_nowait()
        assert event["type"] == "session_deleted"
        assert event["agent_session_id"] == "sess-42"

        broadcaster.remove_client(queue)

    async def test_session_list_change_event(self):
        """broadcast_session_list_change relays arbitrary change events."""
        broadcaster = SessionBroadcaster()
        queue = broadcaster.add_client()

        await broadcaster.broadcast_session_list_change({
            "type": "session_updated",
            "agent_session_id": "s1",
            "status": "completed",
        })

        _eid, event = queue.get_nowait()
        assert event["type"] == "session_updated"
        assert event["agent_session_id"] == "s1"

        broadcaster.remove_client(queue)

    async def test_remove_client_is_safe_for_unknown_queue(self):
        """remove_client() doesn't raise for an unregistered queue."""
        broadcaster = SessionBroadcaster()
        unknown_queue: asyncio.Queue[tuple[int, dict] | None] = asyncio.Queue()
        # Should not raise
        broadcaster.remove_client(unknown_queue)


class TestSessionStreamReplay:
    """Phase 2: Last-Event-ID resume — stream_meta + replay/replay_gap.

    같은 리포의 test_api_sessions_events.py의 _get_events_route + route.endpoint(...)
    + response.body_iterator 패턴을 차용 (동일 라우터 팩토리 create_sessions_router).

    큐 구독 루프 break 패턴: is_disconnected를 두 번째 호출부터 True 반환하도록 하여
    initial yield(stream_meta + session_list/replay) 직후 generator가 정리되도록 한다.
    """

    @staticmethod
    def _disconnect_after_n_calls(n: int):
        """is_disconnected() 호출 카운터 — n번째 호출부터 True 반환."""
        state = {"count": 0}

        async def _check():
            state["count"] += 1
            return state["count"] >= n

        return _check

    async def test_first_connect_yields_stream_meta_then_session_list(
        self, mock_db, node_manager, session_router, mock_catalog_service,
    ):
        """last-event-id 없음 → stream_meta → session_list 순서로 yield."""
        broadcaster = SessionBroadcaster()
        mock_db.get_all_sessions = AsyncMock(return_value=([], 0))

        router = create_sessions_router(
            db=mock_db,
            node_manager=node_manager,
            session_router=session_router,
            broadcaster=broadcaster,
            catalog_service=mock_catalog_service,
        )
        route = _get_stream_route(router)

        request = _make_request_mock()
        # initial yields(stream_meta + session_list) 직후 첫 is_disconnected 체크에서 True
        request.is_disconnected = self._disconnect_after_n_calls(1)
        response = await route.endpoint(request=request)
        events = await _collect_n_events(response.body_iterator, n=4)

        types = [e.get("event") for e in events]
        assert types[0] == "stream_meta"
        assert types[1] == "session_list"

        meta_data = json.loads(events[0]["data"])
        assert meta_data["type"] == "stream_meta"
        assert meta_data["instance_id"] == broadcaster.instance_id
        assert meta_data["latest_id"] == 0  # broadcast 없음

        list_data = json.loads(events[1]["data"])
        assert list_data["type"] == "session_list"
        assert list_data["sessions"] == []
        assert list_data["total"] == 0

        # stream_meta·session_list 모두 SSE id 미부착
        assert events[0].get("id") is None
        assert events[1].get("id") is None

    async def test_reconnect_with_last_event_id_yields_replay(
        self, mock_db, node_manager, session_router, mock_catalog_service,
    ):
        """broadcaster에 3건 broadcast 후 헤더 last-event-id=1 → stream_meta + event_id 2,3."""
        broadcaster = SessionBroadcaster()
        await broadcaster.broadcast({"type": "session_created", "agent_session_id": "s1"})
        await broadcaster.broadcast({"type": "session_updated", "agent_session_id": "s1"})
        await broadcaster.broadcast({"type": "session_deleted", "agent_session_id": "s1"})

        router = create_sessions_router(
            db=mock_db,
            node_manager=node_manager,
            session_router=session_router,
            broadcaster=broadcaster,
            catalog_service=mock_catalog_service,
        )
        route = _get_stream_route(router)

        request = _make_request_mock(headers={"last-event-id": "1"})
        request.is_disconnected = self._disconnect_after_n_calls(1)
        response = await route.endpoint(request=request)
        events = await _collect_n_events(response.body_iterator, n=5)

        types = [e.get("event") for e in events]
        assert types[0] == "stream_meta"
        # replay events: session_updated(id=2), session_deleted(id=3)
        assert "session_updated" in types
        assert "session_deleted" in types

        # SSE id 부착 확인 (replay events)
        ids_yielded = [e.get("id") for e in events if e.get("id") is not None]
        assert "2" in ids_yielded
        assert "3" in ids_yielded
        # stream_meta는 SSE id 미부착
        assert events[0].get("id") is None

        # initial session_list는 미발행 (재연결 분기)
        assert "session_list" not in types

    async def test_query_param_fallback(
        self, mock_db, node_manager, session_router, mock_catalog_service,
    ):
        """헤더 없고 ?lastEventId=2 → event_id 3만 replay."""
        broadcaster = SessionBroadcaster()
        await broadcaster.broadcast({"type": "session_created", "agent_session_id": "a"})
        await broadcaster.broadcast({"type": "session_updated", "agent_session_id": "a"})
        await broadcaster.broadcast({"type": "session_deleted", "agent_session_id": "a"})

        router = create_sessions_router(
            db=mock_db,
            node_manager=node_manager,
            session_router=session_router,
            broadcaster=broadcaster,
            catalog_service=mock_catalog_service,
        )
        route = _get_stream_route(router)

        request = _make_request_mock(query={"lastEventId": "2"})
        request.is_disconnected = self._disconnect_after_n_calls(1)
        response = await route.endpoint(request=request)
        events = await _collect_n_events(response.body_iterator, n=4)

        types = [e.get("event") for e in events]
        assert types[0] == "stream_meta"
        assert "session_deleted" in types

        ids_yielded = [e.get("id") for e in events if e.get("id") is not None]
        assert "3" in ids_yielded
        # 2는 dedup (after lastEventId=2)
        assert "2" not in ids_yielded
        # session_list 미발행
        assert "session_list" not in types

    async def test_header_takes_precedence_over_query(
        self, mock_db, node_manager, session_router, mock_catalog_service,
    ):
        """헤더=1, ?lastEventId=2 → 헤더 우선 (event_id 2,3 yield)."""
        broadcaster = SessionBroadcaster()
        await broadcaster.broadcast({"type": "session_created", "agent_session_id": "a"})
        await broadcaster.broadcast({"type": "session_updated", "agent_session_id": "a"})
        await broadcaster.broadcast({"type": "session_deleted", "agent_session_id": "a"})

        router = create_sessions_router(
            db=mock_db,
            node_manager=node_manager,
            session_router=session_router,
            broadcaster=broadcaster,
            catalog_service=mock_catalog_service,
        )
        route = _get_stream_route(router)

        request = _make_request_mock(
            headers={"last-event-id": "1"},
            query={"lastEventId": "2"},
        )
        request.is_disconnected = self._disconnect_after_n_calls(1)
        response = await route.endpoint(request=request)
        events = await _collect_n_events(response.body_iterator, n=5)

        ids_yielded = [e.get("id") for e in events if e.get("id") is not None]
        # 헤더 적용 → after_id=1 → event_id 2,3 모두
        assert "2" in ids_yielded
        assert "3" in ids_yielded

    async def test_replay_gap_when_id_below_oldest(
        self, mock_db, node_manager, session_router, mock_catalog_service,
    ):
        """recent_events_maxlen=2, broadcast 3건 → ring=[2,3] → 헤더=0 → stream_meta + replay_gap."""
        # maxlen=2로 ring buffer 회전 시뮬레이션
        broadcaster = SessionBroadcaster()
        # 직접 deque maxlen 재설정 (테스트 전용 — 인터페이스 노출은 production code 안전상 X)
        from collections import deque
        broadcaster._recent_events = deque(maxlen=2)

        await broadcaster.broadcast({"type": "session_created", "agent_session_id": "a"})
        await broadcaster.broadcast({"type": "session_updated", "agent_session_id": "a"})
        await broadcaster.broadcast({"type": "session_deleted", "agent_session_id": "a"})
        # ring = [(2, ...), (3, ...)] — id=1 evicted

        router = create_sessions_router(
            db=mock_db,
            node_manager=node_manager,
            session_router=session_router,
            broadcaster=broadcaster,
            catalog_service=mock_catalog_service,
        )
        route = _get_stream_route(router)

        request = _make_request_mock(headers={"last-event-id": "0"})
        request.is_disconnected = self._disconnect_after_n_calls(1)
        response = await route.endpoint(request=request)
        events = await _collect_n_events(response.body_iterator, n=4)

        types = [e.get("event") for e in events]
        assert types[0] == "stream_meta"
        assert "replay_gap" in types

        gap = next(e for e in events if e.get("event") == "replay_gap")
        gap_data = json.loads(gap["data"])
        assert gap_data["type"] == "replay_gap"
        assert gap_data["latest_id"] == 3
        assert gap_data["instance_id"] == broadcaster.instance_id
        # replay_gap은 SSE id 미부착
        assert gap.get("id") is None

        # 누락 이벤트들은 yield되지 않음 (gap 분기는 events 없음)
        ids_yielded = [e.get("id") for e in events if e.get("id") is not None]
        assert ids_yielded == []

    async def test_replay_gap_on_instance_mismatch(
        self, mock_db, node_manager, session_router, mock_catalog_service,
    ):
        """?instanceId=different → stream_meta + replay_gap (서버 재시작 시뮬레이션)."""
        broadcaster = SessionBroadcaster()
        await broadcaster.broadcast({"type": "session_created", "agent_session_id": "a"})

        router = create_sessions_router(
            db=mock_db,
            node_manager=node_manager,
            session_router=session_router,
            broadcaster=broadcaster,
            catalog_service=mock_catalog_service,
        )
        route = _get_stream_route(router)

        request = _make_request_mock(
            headers={"last-event-id": "1"},
            query={"instanceId": "deadbeefcafebabe"},  # 다른 인스턴스
        )
        request.is_disconnected = self._disconnect_after_n_calls(1)
        response = await route.endpoint(request=request)
        events = await _collect_n_events(response.body_iterator, n=4)

        types = [e.get("event") for e in events]
        assert types[0] == "stream_meta"
        assert "replay_gap" in types

        gap = next(e for e in events if e.get("event") == "replay_gap")
        gap_data = json.loads(gap["data"])
        # gap에 명시된 instance_id는 현재 broadcaster의 것 (클라가 lastEventIdRef 전환용)
        assert gap_data["instance_id"] == broadcaster.instance_id

    async def test_dedup_replay_and_live(
        self, mock_db, node_manager, session_router, mock_catalog_service,
    ):
        """replay 호출 사이 broadcast → 큐 사본을 live 단계에서 skip.

        시나리오:
        1. broadcast 2건 → ring=[1,2], queue=비어있음
        2. 클라 재연결 (last_event_id=0) → add_client() → stream_meta yield
        3. replay_since(0) → events=[(1,...),(2,...)]
        4. replay 도중 큐에 (1,...),(2,...)는 들어있지 않지만 (3,...)이 broadcast
           → 큐=[(3,...)], replay_seen_ids={1,2}
        5. live 루프 → (3,...)은 replay_seen_ids에 없으므로 yield. dedup은 정확.

        본 테스트는 replay events가 큐에도 동시에 적재된 경우(즉 add_client 이후 발생한
        broadcast가 ring에도 큐에도 들어가는 경우)에 1번만 yield되는지 검증한다.
        구현상 add_client→stream_meta yield→replay_since 사이 race로 같은 event가
        replay와 큐 양쪽에 있을 수 있어, 이 dedup이 정본이다.
        """
        broadcaster = SessionBroadcaster()
        await broadcaster.broadcast({"type": "session_created", "agent_session_id": "s1"})

        router = create_sessions_router(
            db=mock_db,
            node_manager=node_manager,
            session_router=session_router,
            broadcaster=broadcaster,
            catalog_service=mock_catalog_service,
        )
        route = _get_stream_route(router)

        # is_disconnected 패턴: 2번째 체크부터 True (live 루프 1회만 진입)
        request = _make_request_mock(headers={"last-event-id": "0"})
        request.is_disconnected = self._disconnect_after_n_calls(2)
        response = await route.endpoint(request=request)

        # generator를 첫 yield까지 진행시킨 뒤 broadcast로 race 시뮬레이션
        gen = response.body_iterator
        try:
            # stream_meta
            ev0 = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
            assert ev0["event"] == "stream_meta"
            # replay event_id=1
            ev1 = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
            assert ev1["event"] == "session_created"
            assert ev1["id"] == "1"

            # 이 시점에서 broadcaster.add_client는 이미 호출되었고
            # replay도 끝났다 (replay_seen_ids={1}). 새 broadcast는 큐에 적재만 되어야.
            # 동일 event_id=1이 아닌 새 id=2가 yield되는지 검증.
            await broadcaster.broadcast({"type": "session_updated", "agent_session_id": "s1"})

            # live 루프에서 (2, ...)이 yield
            ev2 = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
            assert ev2["event"] == "session_updated"
            assert ev2["id"] == "2"

            # 추가 yield 없음 (is_disconnected 두 번째 체크에서 break)
            collected_after = []
            try:
                ev3 = await asyncio.wait_for(gen.__anext__(), timeout=0.5)
                collected_after.append(ev3)
            except (asyncio.TimeoutError, StopAsyncIteration):
                pass
            # event_id=1이 live 단계에서 중복 yield 안 됨
            assert all(e.get("id") != "1" for e in collected_after)
        finally:
            await gen.aclose()

    async def test_event_emitted_between_add_client_and_replay_since_is_deduped(
        self, mock_db, node_manager, session_router, mock_catalog_service,
    ):
        """add_client 직후 replay_since 직전에 broadcast된 event_id가
        replay.events와 큐에 모두 있을 때 단 한 번만 yield.

        이 race를 확실히 재현하기 위해, 직접 add_client + 수동 broadcast로
        큐에 동일 event_id를 적재한 뒤 generator 호출.

        현실에서는 replay_since 호출 전에 add_client된 큐에 broadcast가 들어가면
        (1) ring buffer에도 적재 → replay.events에 포함
        (2) 큐에도 적재 → live 단계에서 yield 시도
        → replay_seen_ids dedup으로 단 한 번만 yield되어야 한다.

        본 테스트는 이 dedup의 정확성을 직접 검증한다.
        """
        broadcaster = SessionBroadcaster()

        # 사전: broadcast 1건 (이전 history) — 클라는 last_event_id=0 으로 재연결
        await broadcaster.broadcast({"type": "session_created", "agent_session_id": "s1"})
        # ring=[(1, ...)], counter=1

        router = create_sessions_router(
            db=mock_db,
            node_manager=node_manager,
            session_router=session_router,
            broadcaster=broadcaster,
            catalog_service=mock_catalog_service,
        )
        route = _get_stream_route(router)

        # initial yield 직후 break (live 루프는 큐에 이미 적재된 것만 처리)
        # is_disconnected 패턴: 첫 번째 호출 False, 두 번째 호출 True
        # 첫 번째 체크 → wait_for(queue.get) 1회 진행 → 두 번째 체크 → break
        request = _make_request_mock(headers={"last-event-id": "0"})
        request.is_disconnected = self._disconnect_after_n_calls(2)

        # 핵심 트릭: route.endpoint 호출 전에 임시로 add_client를 가로채서
        # add_client 결과 큐에 직접 (1, event)를 적재한다.
        # 이렇게 하면 generator 진입 시 큐에는 이미 (1, ...)이 들어 있고,
        # replay_since(0)도 (1, ...)을 반환 → dedup이 발동한다.
        original_add_client = broadcaster.add_client
        captured_event = {"type": "session_created", "agent_session_id": "s1"}

        def patched_add_client(maxsize=None):
            queue = original_add_client(maxsize=maxsize)
            # add_client 직후 큐에 동일 event_id=1을 push (race 시뮬레이션)
            queue.put_nowait((1, captured_event))
            return queue

        broadcaster.add_client = patched_add_client

        try:
            response = await route.endpoint(request=request)
            events = await _collect_n_events(response.body_iterator, n=5)
        finally:
            broadcaster.add_client = original_add_client

        # event_id=1은 정확히 1번만 yield되어야 함
        ids_yielded = [e.get("id") for e in events if e.get("id") == "1"]
        assert len(ids_yielded) == 1, (
            f"event_id=1이 replay와 live에서 중복 yield됨: {[e.get('event') + ':' + str(e.get('id')) for e in events]}"
        )
        # replay 단계에서 yield된 것이어야 (큐에서 가져온 게 아니라)
        types = [e.get("event") for e in events]
        assert types[0] == "stream_meta"
        assert types[1] == "session_created"
