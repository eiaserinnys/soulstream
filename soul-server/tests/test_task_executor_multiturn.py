"""TaskExecutor._run_execution() 멀티턴 세션 finalize 타이밍 테스트

멀티턴 세션에서 complete 이벤트는 '턴 종료'이지 '세션 종료'가 아니다.
finalize_task는 async for 루프가 종료된 후(스트림이 진짜 끝난 후)에만 호출되어야 한다.
"""
import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from soul_server.service.task_executor import TaskExecutor
from soul_server.service.task_models import Task, TaskStatus


# ── Mock 이벤트 ──────────────────────────────────────────────


@dataclass
class MockEvent:
    """claude_runner.execute()가 yield하는 이벤트 mock"""
    type: str
    result: Optional[str] = None
    message: Optional[str] = None
    session_id: Optional[str] = None
    tool_name: Optional[str] = None
    text: Optional[str] = None
    user: Optional[str] = None
    is_error: bool = False
    parent_event_id: Optional[str] = None
    _extra: dict = field(default_factory=dict)

    def model_dump(self):
        d = {
            "type": self.type,
            "parent_event_id": self.parent_event_id,
        }
        if self.result is not None:
            d["result"] = self.result
        if self.message is not None:
            d["message"] = self.message
        if self.session_id is not None:
            d["session_id"] = self.session_id
        if self.tool_name is not None:
            d["tool_name"] = self.tool_name
        if self.text is not None:
            d["text"] = self.text
        if self.user is not None:
            d["user"] = self.user
        d.update(self._extra)
        return d


# ── Fixtures ─────────────────────────────────────────────────


@asynccontextmanager
async def _mock_acquire(**kwargs):
    """resource_manager.acquire()의 async context manager mock"""
    yield


def _make_task(session_id="test-session") -> Task:
    """테스트용 Task 생성 (실제 Task 객체 사용)"""
    return Task(
        agent_session_id=session_id,
        prompt="test prompt",
    )


def _make_executor(
    tasks: dict,
    finalize_mock: AsyncMock,
    listener_manager=None,
    session_db=None,
) -> TaskExecutor:
    """테스트용 TaskExecutor 생성"""
    return TaskExecutor(
        tasks=tasks,
        listener_manager=listener_manager or MagicMock(broadcast=AsyncMock()),
        get_intervention_func=AsyncMock(return_value=None),
        finalize_task_func=finalize_mock,
        session_db=session_db,
    )


def _make_claude_runner(events: list):
    """claude_runner mock 생성 — execute()가 주어진 이벤트들을 yield"""
    runner = MagicMock()

    async def mock_execute(**kwargs):
        for event in events:
            yield event

    runner.execute = mock_execute
    runner.workspace_dir = "/test/workspace"
    return runner


def _make_resource_manager():
    """resource_manager mock 생성"""
    rm = MagicMock()
    rm.acquire = _mock_acquire
    return rm


# ── Tests ────────────────────────────────────────────────────


class TestMultiturnFinalize:
    """멀티턴 세션에서 finalize_task 호출 타이밍 검증"""

    @pytest.mark.asyncio
    @patch("soul_server.service.task_executor.build_soulstream_context_item",
           return_value={"type": "soulstream", "mock": True})
    @patch("soul_server.service.task_executor.assemble_prompt",
           return_value="assembled test prompt")
    @patch("soul_server.service.task_executor.get_session_broadcaster")
    async def test_status_stays_running_during_multiturn(
        self, mock_broadcaster, mock_assemble, mock_build_ctx
    ):
        """멀티턴 세션에서 중간 complete 이벤트 시 finalize_task가 호출되지 않고,
        스트림 종료 후 1회만 마지막 result로 호출된다."""
        mock_broadcaster.return_value = MagicMock(
            emit_session_updated=AsyncMock(),
            emit_session_message_updated=AsyncMock(),
        )

        finalize = AsyncMock(return_value=None)
        task = _make_task()
        tasks = {task.agent_session_id: task}
        executor = _make_executor(tasks, finalize)

        # 멀티턴: turn1 → complete → turn2 → complete
        events = [
            MockEvent(type="tool_start", tool_name="Read"),
            MockEvent(type="tool_result", tool_name="Read", _extra={"result": "data"}),
            MockEvent(type="complete", result="turn1 done"),
            # intervention_sent는 콜백에서 처리되므로 메인 루프에서 continue됨
            MockEvent(type="intervention_sent", user="test", text="continue"),
            MockEvent(type="tool_start", tool_name="Write"),
            MockEvent(type="tool_result", tool_name="Write", _extra={"result": "ok"}),
            MockEvent(type="complete", result="turn2 done"),
        ]

        runner = _make_claude_runner(events)
        rm = _make_resource_manager()

        await executor._run_execution(task=task, claude_runner=runner, resource_manager=rm)

        # finalize_task는 스트림 종료 후 정확히 1회 호출
        assert finalize.call_count == 1
        # 마지막 result로 호출
        call_kwargs = finalize.call_args
        assert call_kwargs[0][0] == task.agent_session_id  # session_id
        assert call_kwargs[1]["result"] == "turn2 done"

    @pytest.mark.asyncio
    @patch("soul_server.service.task_executor.build_soulstream_context_item",
           return_value={"type": "soulstream", "mock": True})
    @patch("soul_server.service.task_executor.assemble_prompt",
           return_value="assembled test prompt")
    @patch("soul_server.service.task_executor.get_session_broadcaster")
    async def test_finalize_called_on_stream_end(
        self, mock_broadcaster, mock_assemble, mock_build_ctx
    ):
        """스트림 종료 후 finalize_task가 마지막 result로 정확히 호출된다."""
        mock_broadcaster.return_value = MagicMock(
            emit_session_updated=AsyncMock(),
            emit_session_message_updated=AsyncMock(),
        )

        finalize = AsyncMock(return_value=None)
        task = _make_task()
        tasks = {task.agent_session_id: task}
        executor = _make_executor(tasks, finalize)

        events = [
            MockEvent(type="tool_start", tool_name="Read"),
            MockEvent(type="complete", result="final result"),
        ]

        runner = _make_claude_runner(events)
        rm = _make_resource_manager()

        await executor._run_execution(task=task, claude_runner=runner, resource_manager=rm)

        finalize.assert_called_once()
        assert finalize.call_args[1]["result"] == "final result"

    @pytest.mark.asyncio
    @patch("soul_server.service.task_executor.build_soulstream_context_item",
           return_value={"type": "soulstream", "mock": True})
    @patch("soul_server.service.task_executor.assemble_prompt",
           return_value="assembled test prompt")
    @patch("soul_server.service.task_executor.get_session_broadcaster")
    async def test_single_turn_behavior_unchanged(
        self, mock_broadcaster, mock_assemble, mock_build_ctx
    ):
        """단일턴 세션(complete 1회)에서 기존 동작이 유지된다."""
        mock_broadcaster.return_value = MagicMock(
            emit_session_updated=AsyncMock(),
            emit_session_message_updated=AsyncMock(),
        )

        finalize = AsyncMock(return_value=None)
        task = _make_task()
        tasks = {task.agent_session_id: task}
        executor = _make_executor(tasks, finalize)

        events = [
            MockEvent(type="progress", _extra={"text": "working..."}),
            MockEvent(type="tool_start", tool_name="Bash"),
            MockEvent(type="tool_result", tool_name="Bash", _extra={"result": "output"}),
            MockEvent(type="complete", result="all done"),
        ]

        runner = _make_claude_runner(events)
        rm = _make_resource_manager()

        await executor._run_execution(task=task, claude_runner=runner, resource_manager=rm)

        # 정확히 1회, result="all done"으로 호출
        assert finalize.call_count == 1
        assert finalize.call_args[1]["result"] == "all done"
        # execution_task은 finally에서 None으로 설정됨
        assert task.execution_task is None

    @pytest.mark.asyncio
    @patch("soul_server.service.task_executor.build_soulstream_context_item",
           return_value={"type": "soulstream", "mock": True})
    @patch("soul_server.service.task_executor.assemble_prompt",
           return_value="assembled test prompt")
    @patch("soul_server.service.task_executor.get_session_broadcaster")
    async def test_error_during_multiturn(
        self, mock_broadcaster, mock_assemble, mock_build_ctx
    ):
        """에러 이벤트가 중간에 발생해도 스트림 종료 시 마지막 에러로 finalize된다."""
        mock_broadcaster.return_value = MagicMock(
            emit_session_updated=AsyncMock(),
            emit_session_message_updated=AsyncMock(),
        )

        finalize = AsyncMock(return_value=None)
        task = _make_task()
        tasks = {task.agent_session_id: task}
        executor = _make_executor(tasks, finalize)

        events = [
            MockEvent(type="tool_start", tool_name="Read"),
            MockEvent(type="error", message="something went wrong"),
            # SDK가 에러 후에도 스트림을 유지할 수 있다
            MockEvent(type="tool_start", tool_name="Write"),
            MockEvent(type="complete", result="recovered"),
        ]

        runner = _make_claude_runner(events)
        rm = _make_resource_manager()

        await executor._run_execution(task=task, claude_runner=runner, resource_manager=rm)

        # error가 있으면 result보다 우선
        assert finalize.call_count == 1
        assert finalize.call_args[1]["error"] == "something went wrong"

    @pytest.mark.asyncio
    @patch("soul_server.service.task_executor.build_soulstream_context_item",
           return_value={"type": "soulstream", "mock": True})
    @patch("soul_server.service.task_executor.assemble_prompt",
           return_value="assembled test prompt")
    @patch("soul_server.service.task_executor.get_session_broadcaster")
    async def test_stream_ends_without_complete_or_error(
        self, mock_broadcaster, mock_assemble, mock_build_ctx
    ):
        """스트림이 complete/error 없이 종료되면 에러로 finalize된다."""
        mock_broadcaster.return_value = MagicMock(
            emit_session_updated=AsyncMock(),
            emit_session_message_updated=AsyncMock(),
        )

        finalize = AsyncMock(return_value=None)
        task = _make_task()
        tasks = {task.agent_session_id: task}
        executor = _make_executor(tasks, finalize)

        events = [
            MockEvent(type="tool_start", tool_name="Read"),
            MockEvent(type="progress", _extra={"text": "working..."}),
            # complete도 error도 없이 스트림 종료
        ]

        runner = _make_claude_runner(events)
        rm = _make_resource_manager()

        await executor._run_execution(task=task, claude_runner=runner, resource_manager=rm)

        assert finalize.call_count == 1
        assert "without completion" in finalize.call_args[1]["error"]
