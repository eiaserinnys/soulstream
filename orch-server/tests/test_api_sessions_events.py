"""orch-server `/api/sessions/{id}/events` SSE 엔드포인트 테스트.

핵심 검증 항목:
- after_id=0(또는 미전송): DB 히스토리 skip, history_sync만 송출 후 라이브 진입
- after_id>0: 그 이후 이벤트만 stream_events_raw로 스트리밍 + history_sync + 라이브
- history_sync는 항상 init 다음 또는 history phase 직후에 발행 (라이브 진입 직전)
- ?lastEventId 쿼리 파라미터도 Last-Event-ID 헤더와 동일하게 인식
- history phase에서 yield된 event_id는 seen_event_ids에 등록되어 라이브 dedup에 활용

mode/live_only 파라미터는 제거되었다 (모든 대시보드가 messages API + 라이브 SSE 패턴 사용).

라우트 핸들러를 직접 호출하고 EventSourceResponse.body_iterator를 직접 iterate하는 패턴
(soul-server tests/test_sessions_history.py와 동일).
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from soulstream_server.api.sessions import create_sessions_router
from soulstream_server.service.session_broadcaster import SessionBroadcaster


pytestmark = pytest.mark.asyncio


def _patch_db_stream(mock_db, events: list[tuple[int, str, str]]):
    """mock_db.stream_events_raw가 events를 yield하도록 패치.

    events: [(event_id, event_type, payload_text), ...]
    """
    async def fake_stream(session_id, after_id=0):
        for eid, etype, payload in events:
            if eid > after_id:
                yield eid, etype, payload

    mock_db.stream_events_raw = fake_stream


def _make_request_mock(headers: dict | None = None, query: dict | None = None) -> MagicMock:
    """orch-server session_events가 사용하는 Request의 최소 mock.

    - headers.get(name, default)
    - query_params.get(name, default)
    - is_disconnected() (라이브 phase 진입 차단을 위해 항상 True 반환 가능)
    """
    request = MagicMock()
    request.headers = headers or {}
    request.query_params = query or {}
    # 라이브 phase 진입 차단을 위해 is_disconnected가 True 반환하도록 가능
    request.is_disconnected = AsyncMock(return_value=False)
    return request


def _get_events_route(router):
    """SSE events 라우트 endpoint 추출.

    APIRouter(prefix="/api/sessions") + @router.get("/{session_id}/events")이면
    실제 등록 path는 prefix가 합쳐진 "/api/sessions/{session_id}/events"이다.
    /events/viewport는 더 구체적 경로이므로 제외 매칭.
    """
    return next(
        r for r in router.routes
        if getattr(r, "path", "") == "/api/sessions/{session_id}/events"
    )


async def _collect_until_history_sync(gen, *, timeout_per_step: float = 1.0, max_extra: int = 0):
    """generator에서 history_sync까지 모은 뒤 max_extra개 더 수집.

    finally + aclose로 generator 정리.
    """
    events = []
    history_sync_seen = False
    extras_collected = 0
    try:
        while True:
            try:
                event = await asyncio.wait_for(gen.__anext__(), timeout=timeout_per_step)
            except (asyncio.TimeoutError, StopAsyncIteration):
                break
            events.append(event)
            if event.get("event") == "history_sync":
                history_sync_seen = True
                if max_extra == 0:
                    break
                continue
            if history_sync_seen:
                extras_collected += 1
                if extras_collected >= max_extra:
                    break
    finally:
        await gen.aclose()
    return events


class TestAfterIdZeroSkipsHistory:
    """after_id=0 시 히스토리 stream_events_raw가 호출되지 않고 history_sync만 송출."""

    async def test_after_id_zero_skips_history(
        self, mock_db, node_manager, session_router, mock_catalog_service, broadcaster,
    ):
        """Last-Event-ID 미전송 → after_id=0 → stream_events_raw 호출 없음, history_sync 송출."""
        # mock_db.stream_events_raw가 호출되었는지 추적
        stream_called = False

        async def fake_stream(*args, **kwargs):
            nonlocal stream_called
            stream_called = True
            if False:
                yield  # never

        mock_db.stream_events_raw = fake_stream
        mock_db.read_last_event_id = AsyncMock(return_value=42)
        # find_session_node가 HTTPException(404)을 던지도록 — 라이브 phase 진입 차단
        mock_db.get_session = AsyncMock(return_value=None)

        router = create_sessions_router(
            db=mock_db,
            node_manager=node_manager,
            session_router=session_router,
            broadcaster=broadcaster,
            catalog_service=mock_catalog_service,
        )
        route = _get_events_route(router)

        request = _make_request_mock()
        response = await route.endpoint(session_id="sess-1", request=request)
        events = await _collect_until_history_sync(response.body_iterator)

        assert not stream_called, "stream_events_raw가 호출되면 안 됨 (after_id=0은 skip)"

        # init + history_sync (find_session_node 실패 시 라이브 phase 진입 안 함)
        assert len(events) >= 2
        assert events[0]["event"] == "init"
        history_sync = next(e for e in events if e.get("event") == "history_sync")
        sync_data = json.loads(history_sync["data"])
        assert sync_data["last_event_id"] == 42
        assert sync_data["type"] == "history_sync"
        # 노드를 못 찾으면 is_live=False (UI가 라이브 대기 상태로 잘못 표시되는 것 방지)
        assert sync_data["is_live"] is False

    async def test_after_id_zero_flushes_subscribe_gap_before_history_sync(
        self, mock_db, node_manager, session_router, mock_catalog_service, broadcaster,
    ):
        """baseline 읽기 중 live 큐에 들어온 이벤트는 history_sync보다 먼저 송출한다."""
        mock_db.stream_events_raw = AsyncMock()
        mock_db.read_last_event_id = AsyncMock(return_value=43)

        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        await node_manager.register_node(
            ws, {"node_id": "test-node", "host": "localhost", "port": 4100},
        )
        mock_db.get_session = AsyncMock(
            return_value={"session_id": "sess-1", "node_id": "test-node"},
        )

        async def fake_subscribe_events(self, session_id, on_event):
            await on_event({
                "eventId": 43,
                "event": {"type": "text_delta", "text": "gap", "_event_id": 43},
            })
            return "sub-1"

        def fake_unsubscribe_events(self, session_id, subscribe_id):
            return None

        from soulstream_server.nodes.node_connection import NodeConnection

        original_subscribe = NodeConnection.send_subscribe_events
        original_unsubscribe = NodeConnection.unsubscribe_events
        NodeConnection.send_subscribe_events = fake_subscribe_events
        NodeConnection.unsubscribe_events = fake_unsubscribe_events

        try:
            router = create_sessions_router(
                db=mock_db,
                node_manager=node_manager,
                session_router=session_router,
                broadcaster=broadcaster,
                catalog_service=mock_catalog_service,
            )
            route = _get_events_route(router)

            request = _make_request_mock()
            response = await route.endpoint(session_id="sess-1", request=request)
            events = await _collect_until_history_sync(response.body_iterator)

            event_names = [e.get("event") for e in events]
            assert event_names[:3] == ["init", "text_delta", "history_sync"]
            assert events[1]["id"] == "43"
            sync_data = json.loads(events[2]["data"])
            assert sync_data["last_event_id"] == 43
            mock_db.stream_events_raw.assert_not_called()
        finally:
            NodeConnection.send_subscribe_events = original_subscribe
            NodeConnection.unsubscribe_events = original_unsubscribe


class TestAfterIdNStreamsAfterN:
    """after_id>0 시 그 이후 이벤트만 스트리밍 + history_sync."""

    async def test_after_id_n_streams_after_n(
        self, mock_db, node_manager, session_router, mock_catalog_service, broadcaster,
    ):
        """Last-Event-ID=5 → event_id 6, 7만 스트리밍 + history_sync."""
        _patch_db_stream(
            mock_db,
            [
                (1, "text_start", '{"type":"text_start"}'),
                (5, "text_delta", '{"type":"text_delta"}'),
                (6, "text_delta", '{"type":"text_delta","text":"hi"}'),
                (7, "text_end", '{"type":"text_end"}'),
            ],
        )
        mock_db.read_last_event_id = AsyncMock(return_value=7)
        mock_db.get_session = AsyncMock(return_value=None)  # find_session_node 404

        router = create_sessions_router(
            db=mock_db,
            node_manager=node_manager,
            session_router=session_router,
            broadcaster=broadcaster,
            catalog_service=mock_catalog_service,
        )
        route = _get_events_route(router)

        request = _make_request_mock(headers={"Last-Event-ID": "5"})
        response = await route.endpoint(session_id="sess-1", request=request)
        events = await _collect_until_history_sync(response.body_iterator)

        # init + event_id=6 + event_id=7 + history_sync
        assert events[0]["event"] == "init"
        ids_yielded = [e.get("id") for e in events if e.get("id")]
        assert "6" in ids_yielded
        assert "7" in ids_yielded
        history_sync = next(e for e in events if e.get("event") == "history_sync")
        sync_data = json.loads(history_sync["data"])
        assert sync_data["last_event_id"] == 7


class TestQueryParamLastEventId:
    """?lastEventId 쿼리 파라미터로도 after_id 인식."""

    async def test_query_param_last_event_id(
        self, mock_db, node_manager, session_router, mock_catalog_service, broadcaster,
    ):
        """?lastEventId=3 → event_id 4, 5만 스트리밍."""
        _patch_db_stream(
            mock_db,
            [
                (3, "a", "{}"),
                (4, "b", "{}"),
                (5, "c", "{}"),
            ],
        )
        mock_db.read_last_event_id = AsyncMock(return_value=5)
        mock_db.get_session = AsyncMock(return_value=None)

        router = create_sessions_router(
            db=mock_db,
            node_manager=node_manager,
            session_router=session_router,
            broadcaster=broadcaster,
            catalog_service=mock_catalog_service,
        )
        route = _get_events_route(router)

        # 헤더 없이 query param만
        request = _make_request_mock(query={"lastEventId": "3"})
        response = await route.endpoint(session_id="sess-1", request=request)
        events = await _collect_until_history_sync(response.body_iterator)

        ids_yielded = [e.get("id") for e in events if e.get("id")]
        assert "4" in ids_yielded
        assert "5" in ids_yielded
        # 3은 dedup되어야 함 (after_id=3이므로 id>3만)
        assert "3" not in ids_yielded


class TestHistorySyncAlwaysEmittedFirst:
    """init 다음(또는 history 직후)으로 history_sync가 항상 발행."""

    async def test_history_sync_always_emitted_after_init(
        self, mock_db, node_manager, session_router, mock_catalog_service, broadcaster,
    ):
        """빈 세션 + after_id=0 시에도 init 다음에 history_sync가 즉시 발행."""
        mock_db.read_last_event_id = AsyncMock(return_value=0)
        mock_db.get_session = AsyncMock(return_value=None)

        router = create_sessions_router(
            db=mock_db,
            node_manager=node_manager,
            session_router=session_router,
            broadcaster=broadcaster,
            catalog_service=mock_catalog_service,
        )
        route = _get_events_route(router)

        request = _make_request_mock()
        response = await route.endpoint(session_id="sess-empty", request=request)
        events = await _collect_until_history_sync(response.body_iterator)

        # init이 첫 프레임, history_sync가 그 다음 (history phase 빈 세션이라 즉시)
        assert events[0]["event"] == "init"
        assert events[1]["event"] == "history_sync"
        sync_data = json.loads(events[1]["data"])
        assert sync_data["last_event_id"] == 0
        # find_session_node가 실패한 빈 세션 → is_live=False
        assert sync_data["is_live"] is False


class TestHistoryPhaseDisconnectAndError:
    """history phase에서 mid-stream disconnect / 예외 발생 시 동작."""

    async def test_mid_stream_disconnect_terminates_before_history_sync(
        self, mock_db, node_manager, session_router, mock_catalog_service, broadcaster,
    ):
        """history phase 도중 클라이언트 disconnect → history_sync 발행 없이 즉시 종료.

        request.is_disconnected()가 True를 반환하면 generator가 return되어
        history_sync도 라이브 진입도 일어나지 않는다.
        """
        _patch_db_stream(
            mock_db,
            [(1, "a", "{}"), (2, "b", "{}"), (3, "c", "{}")],
        )
        mock_db.read_last_event_id = AsyncMock(return_value=3)
        mock_db.get_session = AsyncMock(return_value=None)

        # 첫 yield 직후 disconnect 보고
        disconnect_calls = {"count": 0}

        async def fake_is_disconnected():
            disconnect_calls["count"] += 1
            return disconnect_calls["count"] >= 2  # 두 번째 호출부터 True

        router = create_sessions_router(
            db=mock_db,
            node_manager=node_manager,
            session_router=session_router,
            broadcaster=broadcaster,
            catalog_service=mock_catalog_service,
        )
        route = _get_events_route(router)

        request = MagicMock()
        request.headers = {"Last-Event-ID": "0"}
        request.query_params = {}
        request.is_disconnected = fake_is_disconnected

        # after_id>0이어야 stream_events_raw 진입
        request.headers = {"Last-Event-ID": "1"}
        response = await route.endpoint(session_id="sess-1", request=request)

        events = []
        try:
            for _ in range(6):
                try:
                    event = await asyncio.wait_for(
                        response.body_iterator.__anext__(), timeout=1.0,
                    )
                except (asyncio.TimeoutError, StopAsyncIteration):
                    break
                events.append(event)
        finally:
            await response.body_iterator.aclose()

        # init은 받음, 첫 history 이벤트(id=2 또는 3) 일부 받은 뒤 disconnect로 종료.
        # history_sync는 발행되지 않아야 함.
        types = [e.get("event") for e in events]
        assert "init" in types
        assert "history_sync" not in types, (
            f"disconnect 후에도 history_sync 발행됨: {types}"
        )

    async def test_history_stream_exception_terminates_before_history_sync(
        self, mock_db, node_manager, session_router, mock_catalog_service, broadcaster,
    ):
        """stream_events_raw가 예외를 던지면 history_sync 없이 generator 종료.

        명시적 실패 (design-principles §4): 부분 catch-up을 정상 종료로 위장하지 않는다.
        """
        async def failing_stream(session_id, after_id=0):
            # 첫 이벤트 yield 후 예외
            yield 2, "text_start", '{"type":"text_start"}'
            raise RuntimeError("DB connection lost")

        mock_db.stream_events_raw = failing_stream
        mock_db.get_session = AsyncMock(return_value=None)

        router = create_sessions_router(
            db=mock_db,
            node_manager=node_manager,
            session_router=session_router,
            broadcaster=broadcaster,
            catalog_service=mock_catalog_service,
        )
        route = _get_events_route(router)

        request = _make_request_mock(headers={"Last-Event-ID": "1"})
        response = await route.endpoint(session_id="sess-1", request=request)

        events = []
        try:
            for _ in range(5):
                try:
                    event = await asyncio.wait_for(
                        response.body_iterator.__anext__(), timeout=1.0,
                    )
                except (asyncio.TimeoutError, StopAsyncIteration):
                    break
                events.append(event)
        finally:
            await response.body_iterator.aclose()

        types = [e.get("event") for e in events]
        # init + 첫 이벤트(id=2)는 받지만 예외 후 history_sync는 없음
        assert "init" in types
        assert "history_sync" not in types, (
            f"stream 예외 후에도 history_sync 발행됨: {types}"
        )


class TestHistoryEventsRegisteredInSeenIds:
    """history phase에서 yield된 event_id가 seen_event_ids에 등록되어,
    라이브 phase에서 같은 id가 들어와도 중복 yield되지 않는지 검증."""

    async def test_history_events_registered_in_seen_ids(
        self, mock_db, node_manager, session_router, mock_catalog_service, broadcaster,
    ):
        """history phase에서 id=10이 yield된 후, 라이브 phase에서 같은 id=10이 와도 중복 yield 안 됨."""
        _patch_db_stream(
            mock_db,
            [
                (10, "text_start", '{"type":"text_start"}'),
            ],
        )
        mock_db.read_last_event_id = AsyncMock(return_value=10)

        # 노드 등록 + WebSocket을 통한 subscribe_events 결과 mock
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        registered = await node_manager.register_node(
            ws, {"node_id": "test-node", "host": "localhost", "port": 4100},
        )
        mock_db.get_session = AsyncMock(
            return_value={"session_id": "sess-1", "node_id": "test-node"},
        )

        # send_subscribe_events가 history와 같은 id=10 + 새 id=11을 보내도록 시뮬레이션
        async def fake_subscribe_events(self, session_id, on_event):
            await on_event({
                "eventId": 10,
                "event": {"type": "text_start", "_event_id": 10},
            })
            await on_event({
                "eventId": 11,
                "event": {"type": "text_delta", "_event_id": 11},
            })
            return "sub-1"

        def fake_unsubscribe_events(self, session_id, subscribe_id):
            return None

        from soulstream_server.nodes.node_connection import NodeConnection

        # NodeConnection 인스턴스의 메서드 패치 (instance method)
        original_subscribe = NodeConnection.send_subscribe_events
        original_unsubscribe = NodeConnection.unsubscribe_events
        NodeConnection.send_subscribe_events = fake_subscribe_events
        NodeConnection.unsubscribe_events = fake_unsubscribe_events

        try:
            router = create_sessions_router(
                db=mock_db,
                node_manager=node_manager,
                session_router=session_router,
                broadcaster=broadcaster,
                catalog_service=mock_catalog_service,
            )
            route = _get_events_route(router)

            request = _make_request_mock(query={"lastEventId": "5"})
            response = await route.endpoint(session_id="sess-1", request=request)

            # 시나리오: init + history(id=10) + history_sync + live(id=11)
            # id=10은 history와 live 모두에서 들어와도 1번만 yield
            events = []
            try:
                for _ in range(8):
                    try:
                        event = await asyncio.wait_for(
                            response.body_iterator.__anext__(), timeout=1.0,
                        )
                    except (asyncio.TimeoutError, StopAsyncIteration):
                        break
                    events.append(event)
                    # 충분히 모았으면 멈춤
                    if any(e.get("id") == "11" for e in events):
                        break
            finally:
                await response.body_iterator.aclose()

            ids_yielded = [e.get("id") for e in events if e.get("id")]
            # id=10은 history phase에서 1번만 yield
            assert ids_yielded.count("10") == 1, (
                f"id=10이 history와 live에서 중복 yield됨: {ids_yielded}"
            )
            # id=11는 라이브로 정상 yield
            assert "11" in ids_yielded
        finally:
            NodeConnection.send_subscribe_events = original_subscribe
            NodeConnection.unsubscribe_events = original_unsubscribe

    async def test_reconnect_cursor_equal_live_event_id_is_not_duplicated(
        self, mock_db, node_manager, session_router, mock_catalog_service, broadcaster,
    ):
        """Last-Event-ID와 같은 live event는 이미 클라이언트가 받은 이벤트라 재송출하지 않는다."""
        _patch_db_stream(
            mock_db,
            [
                (10, "text_start", '{"type":"text_start"}'),
            ],
        )
        mock_db.read_last_event_id = AsyncMock(return_value=10)

        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        await node_manager.register_node(
            ws, {"node_id": "test-node", "host": "localhost", "port": 4100},
        )
        mock_db.get_session = AsyncMock(
            return_value={"session_id": "sess-1", "node_id": "test-node"},
        )

        async def fake_subscribe_events(self, session_id, on_event):
            await on_event({
                "eventId": 10,
                "event": {"type": "text_start", "_event_id": 10},
            })
            await on_event({
                "eventId": 11,
                "event": {"type": "text_delta", "text": "new", "_event_id": 11},
            })
            return "sub-1"

        def fake_unsubscribe_events(self, session_id, subscribe_id):
            return None

        from soulstream_server.nodes.node_connection import NodeConnection

        original_subscribe = NodeConnection.send_subscribe_events
        original_unsubscribe = NodeConnection.unsubscribe_events
        NodeConnection.send_subscribe_events = fake_subscribe_events
        NodeConnection.unsubscribe_events = fake_unsubscribe_events

        try:
            router = create_sessions_router(
                db=mock_db,
                node_manager=node_manager,
                session_router=session_router,
                broadcaster=broadcaster,
                catalog_service=mock_catalog_service,
            )
            route = _get_events_route(router)

            request = _make_request_mock(headers={"Last-Event-ID": "10"})
            response = await route.endpoint(session_id="sess-1", request=request)

            events = []
            try:
                for _ in range(8):
                    try:
                        event = await asyncio.wait_for(
                            response.body_iterator.__anext__(), timeout=1.0,
                        )
                    except (asyncio.TimeoutError, StopAsyncIteration):
                        break
                    events.append(event)
                    if any(e.get("id") == "11" for e in events):
                        break
            finally:
                await response.body_iterator.aclose()

            ids_yielded = [e.get("id") for e in events if e.get("id")]
            assert ids_yielded.count("10") == 0, (
                f"Last-Event-ID와 같은 live id=10이 중복 yield됨: {ids_yielded}"
            )
            assert ids_yielded.count("11") == 1
        finally:
            NodeConnection.send_subscribe_events = original_subscribe
            NodeConnection.unsubscribe_events = original_unsubscribe
