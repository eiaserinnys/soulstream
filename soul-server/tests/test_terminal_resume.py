"""terminal 상태(completed/error/interrupted)에서 후속 메시지 시 기존 Claude 세션을 resume.

핵심 정책:
- terminal 분기에서 submit_message가 기존 claude_session_id를 task.resume_session_id에 보존
- task_executor._run_execution이 engine_adapter.execute에 기존 resume_session_id를 forward
- engine_adapter는 client_lifecycle.build_options에서 ClaudeAgentOptions.resume을 설정
- → Claude SDK가 기존 conversation을 이어간다

본 테스트는 task_executor가 *engine_adapter에 resume_session_id를 forward*하는지를
직접 검증하여 resume wire 끝까지의 정합을 보호한다.
"""

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from soul_server.service.task_executor import TaskExecutor
from soul_server.service.task_models import Task


@asynccontextmanager
async def _mock_acquire(**kwargs):
    yield


def _make_task(
    session_id: str = "test-session",
    claude_session_id: str = None,
    resume_session_id: str = None,
) -> Task:
    t = Task(agent_session_id=session_id, prompt="hello")
    t.claude_session_id = claude_session_id
    t.resume_session_id = resume_session_id
    return t


def _make_db(folder_settings=None):
    db = MagicMock()
    db.node_id = "test-node"
    db.get_session = AsyncMock(return_value={"folder_id": "folder-1"})
    db.get_folder = AsyncMock(return_value={"name": "테스트", "settings": folder_settings})
    db.update_session = AsyncMock()
    return db


def _make_capturing_runner(captured_kwargs: dict):
    runner = MagicMock()

    async def mock_execute(**kwargs):
        captured_kwargs.update(kwargs)
        yield MagicMock(
            type="complete",
            result="done",
            message=None,
            session_id=None,
            tool_name=None,
            text=None,
            user=None,
            is_error=False,
            parent_event_id=None,
            model_dump=lambda: {"type": "complete", "result": "done"},
        )

    runner.execute = mock_execute
    runner.workspace_dir = "/test/workspace"
    return runner


def _make_executor(task: Task, db):
    tasks = {task.agent_session_id: task}
    return TaskExecutor(
        tasks=tasks,
        listener_manager=MagicMock(broadcast=AsyncMock()),
        get_intervention_func=AsyncMock(return_value=None),
        finalize_task_func=AsyncMock(return_value=None),
        session_db=db,
    )


def _make_rm():
    rm = MagicMock()
    rm.acquire = _mock_acquire
    return rm


class TestTerminalResume:
    """terminal-resume 후 task_executor → engine_adapter wire에서 resume_session_id 보존."""

    @pytest.mark.asyncio
    @patch("soul_server.service.execution_context_builder.build_soulstream_context_item",
           return_value={"key": "soulstream_session", "content": {}})
    @patch("soul_server.service.execution_context_builder.assemble_prompt",
           return_value="assembled")
    @patch("soul_server.service.task_executor.get_session_broadcaster")
    async def test_resume_session_id_forwarded_to_engine(
        self, mock_broadcaster, mock_assemble, mock_build
    ):
        """task.resume_session_id가 있으면 engine_adapter.execute가 그대로 받는다."""
        mock_broadcaster.return_value = MagicMock(
            emit_session_updated=AsyncMock(),
            emit_session_message_updated=AsyncMock(),
        )

        db = _make_db()
        # terminal-resume 후의 상태 — claude_session_id를 resume_session_id로 보존
        task = _make_task(
            claude_session_id="claude-prev-session",
            resume_session_id="claude-prev-session",
        )

        captured: dict = {}
        runner = _make_capturing_runner(captured)
        executor = _make_executor(task, db)

        await executor._run_execution(task=task, claude_runner=runner, resource_manager=_make_rm())

        assert "resume_session_id" in captured
        assert captured["resume_session_id"] == "claude-prev-session"
        # task의 agent_session_id는 그대로 forward (soulstream 차원의 세션 묶음 유지)
        assert captured["agent_session_id"] == task.agent_session_id

    @pytest.mark.asyncio
    @patch("soul_server.service.execution_context_builder.build_soulstream_context_item",
           return_value={"key": "soulstream_session", "content": {}})
    @patch("soul_server.service.execution_context_builder.assemble_prompt",
           return_value="assembled")
    @patch("soul_server.service.task_executor.get_session_broadcaster")
    async def test_resume_session_id_set_when_skip_claude_resume_false(
        self, mock_broadcaster, mock_assemble, mock_build
    ):
        """skip_claude_resume이 False인 경로에서는 resume_session_id가 engine에 forward된다."""
        mock_broadcaster.return_value = MagicMock(
            emit_session_updated=AsyncMock(),
            emit_session_message_updated=AsyncMock(),
        )

        db = _make_db()
        # 직접 create_task로 resume 시뮬레이션 (skip_claude_resume=False 기본)
        task = _make_task(
            claude_session_id="claude-legacy",
            resume_session_id="claude-legacy",  # task_factory가 박은 그대로
        )

        captured: dict = {}
        runner = _make_capturing_runner(captured)
        executor = _make_executor(task, db)

        await executor._run_execution(task=task, claude_runner=runner, resource_manager=_make_rm())

        assert captured["resume_session_id"] == "claude-legacy"
