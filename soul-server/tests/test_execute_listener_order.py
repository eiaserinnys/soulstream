"""
execute_task add_listener 순서 검증 + 실패 시 cleanup 검증.

execute_task에서 add_listener가 start_execution 이전에 호출되는지 확인한다.
이벤트 유실을 방지하는 핵심 불변량이다 (sse_streaming.py 코어 docstring 참조).

route.endpoint() 패턴 사용 — test_api_session_events.py 참조.
EventSourceResponse는 ASGI이므로 TestClient 대신 직접 호출한다.
"""

import asyncio
import pytest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

from sse_starlette.sse import EventSourceResponse

from soul_server.service.task_models import Task, TaskStatus
from soul_server.models import ExecuteRequest


def _make_task():
    """테스트용 Task 인스턴스를 생성한다."""
    return Task(
        agent_session_id="sess-test",
        prompt="Test prompt",
        status=TaskStatus.RUNNING,
        client_id="test-client",
        created_at=datetime(2026, 5, 4, 0, 0, 0, tzinfo=timezone.utc),
    )


def _make_task_manager_with_call_order():
    """호출 순서를 기록하는 mock task_manager를 생성한다."""
    manager = MagicMock()
    call_order: list[str] = []
    task = _make_task()

    async def mock_create_task(**kwargs):
        return task

    async def mock_add_listener(agent_session_id, queue):
        call_order.append("add_listener")

    async def mock_start_execution(**kwargs):
        call_order.append("start_execution")

    async def mock_remove_listener(agent_session_id, queue):
        call_order.append("remove_listener")

    manager.create_task = AsyncMock(side_effect=mock_create_task)
    manager.listener_manager.add_listener = AsyncMock(side_effect=mock_add_listener)
    manager.executor.start_execution = AsyncMock(side_effect=mock_start_execution)
    manager.listener_manager.remove_listener = AsyncMock(side_effect=mock_remove_listener)

    return manager, call_order


def _make_body_and_request():
    """테스트용 ExecuteRequest body와 HTTP request mock을 생성한다."""
    body = ExecuteRequest(prompt="hello")

    request = MagicMock()
    request.client = MagicMock()
    request.client.host = "127.0.0.1"
    request.headers = {}

    return body, request


def _patches(manager):
    """execute_task의 의존성을 패치하는 context manager 조합."""
    from contextlib import ExitStack
    stack = ExitStack()
    stack.enter_context(patch("soul_server.api.tasks.get_task_manager", return_value=manager))
    stack.enter_context(patch("soul_server.api.tasks.get_soul_engine", return_value=MagicMock()))
    stack.enter_context(patch("soul_server.api.tasks.resource_manager", new=MagicMock(can_acquire=MagicMock(return_value=True))))
    stack.enter_context(patch("soul_server.api.tasks.verify_token", return_value="test-token"))
    settings_mock = MagicMock()
    settings_mock.soulstream_node_id = "node-1"
    stack.enter_context(patch("soul_server.api.tasks.get_settings", return_value=settings_mock))
    return stack


class TestAddListenerBeforeStartExecution:
    """add_listener가 start_execution 이전에 호출되는지 검증."""

    @pytest.mark.asyncio
    async def test_add_listener_called_before_start_execution(self):
        """add_listener → start_execution 순서를 검증한다.

        execute_task에서 queue 사전 등록은 start_execution이 시작한
        백그라운드 태스크가 broadcast하는 이벤트의 유실을 방지한다.
        (session_events_sse_generator L116-117과 동일한 패턴)
        """
        manager, call_order = _make_task_manager_with_call_order()
        body, request = _make_body_and_request()

        with _patches(manager):
            from soul_server.api.tasks import execute_task

            response = await execute_task(body, request, "test-token")
            assert isinstance(response, EventSourceResponse)

            # 핵심 검증: add_listener가 start_execution 이전에 호출
            assert "add_listener" in call_order, "add_listener가 호출되지 않았다"
            assert "start_execution" in call_order, "start_execution이 호출되지 않았다"

            add_idx = call_order.index("add_listener")
            start_idx = call_order.index("start_execution")
            assert add_idx < start_idx, (
                f"add_listener({add_idx})가 start_execution({start_idx}) 이후에 호출됐다. "
                "이벤트 유실 위험 — add_listener를 start_execution 이전으로 이동해야 한다."
            )


class TestListenerCleanupOnStartExecutionFailure:
    """start_execution 실패 시 listener cleanup 검증."""

    @pytest.mark.asyncio
    async def test_listener_cleanup_on_start_execution_failure(self):
        """start_execution이 예외를 raise하면 remove_listener가 호출되어야 한다.

        add_listener와 start_execution은 상호 배타적으로 cleanup 책임을 진다:
        - start_execution 성공 → stream_live_events finally가 remove_listener 담당
        - start_execution 실패 → execute_task의 except가 remove_listener 담당
        """
        manager, call_order = _make_task_manager_with_call_order()

        # start_execution이 예외를 발생시키도록 설정
        async def mock_start_execution_failure(**kwargs):
            call_order.append("start_execution")
            raise RuntimeError("Claude runner failed to start")

        manager.executor.start_execution = AsyncMock(side_effect=mock_start_execution_failure)

        body, request = _make_body_and_request()

        with _patches(manager):
            from soul_server.api.tasks import execute_task

            with pytest.raises(RuntimeError, match="Claude runner failed to start"):
                await execute_task(body, request, "test-token")

            # cleanup 검증: remove_listener가 호출되어야 함
            assert "remove_listener" in call_order, (
                "start_execution 실패 시 remove_listener가 호출되지 않았다. "
                "listener leak 위험."
            )
