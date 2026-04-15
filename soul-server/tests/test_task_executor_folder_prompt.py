"""TaskExecutor._run_execution() 폴더 프롬프트 주입 테스트

새 세션에서만 folder.settings.folderPrompt가 context item으로 주입되고,
resume 세션이나 folderPrompt가 없는 경우에는 주입되지 않음을 검증한다.
"""
from contextlib import asynccontextmanager
from typing import Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from soul_server.service.task_executor import TaskExecutor
from soul_server.service.task_models import Task


# ── Helpers ──────────────────────────────────────────────────


@asynccontextmanager
async def _mock_acquire(**kwargs):
    yield


def _make_task(
    session_id: str = "test-session",
    resume_session_id: Optional[str] = None,
) -> Task:
    t = Task(
        agent_session_id=session_id,
        prompt="test prompt",
    )
    t.resume_session_id = resume_session_id
    return t


def _make_db(folder_settings: Optional[dict] = None) -> MagicMock:
    """folder_row에 settings를 포함한 DB mock 생성"""
    db = MagicMock()
    db.node_id = "test-node"

    session_row = {"folder_id": "folder-1"}
    folder_row = {
        "name": "테스트 폴더",
        "settings": folder_settings,
    }

    db.get_session = AsyncMock(return_value=session_row)
    db.get_folder = AsyncMock(return_value=folder_row)
    db.persist_event = AsyncMock(return_value=1)
    db.update_session = AsyncMock()
    return db


def _make_executor(task: Task, db=None) -> TaskExecutor:
    tasks = {task.agent_session_id: task}
    return TaskExecutor(
        tasks=tasks,
        listener_manager=MagicMock(broadcast=AsyncMock()),
        get_intervention_func=AsyncMock(return_value=None),
        finalize_task_func=AsyncMock(return_value=None),
        session_db=db,
    )


def _make_claude_runner(captured_context: list, captured_kwargs: dict = None) -> MagicMock:
    """execute() 호출 시 context_items와 system_prompt를 캡처하는 runner mock"""
    runner = MagicMock()

    async def mock_execute(**kwargs):
        captured_context.extend(kwargs.get("context_items", []))
        if captured_kwargs is not None:
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


def _make_resource_manager():
    rm = MagicMock()
    rm.acquire = _mock_acquire
    return rm


# ── Tests ────────────────────────────────────────────────────


class TestFolderPromptInjection:
    """폴더 프롬프트 context item 주입 검증"""

    @pytest.mark.asyncio
    @patch("soul_server.service.task_executor.build_soulstream_context_item",
           return_value={"key": "soulstream_session", "content": {}})
    @patch("soul_server.service.task_executor.assemble_prompt",
           return_value="assembled prompt")
    @patch("soul_server.service.task_executor.get_session_broadcaster")
    async def test_folder_prompt_injected_for_new_session(
        self, mock_broadcaster, mock_assemble, mock_build_ctx
    ):
        """새 세션에서 folderPrompt가 있으면 system_prompt에 주입된다."""
        mock_broadcaster.return_value = MagicMock(
            emit_session_updated=AsyncMock(),
            emit_session_message_updated=AsyncMock(),
        )

        db = _make_db(folder_settings={"folderPrompt": "항상 한국어로 답하세요."})
        task = _make_task(resume_session_id=None)  # 새 세션

        captured_context: list = []
        captured_kwargs: dict = {}
        runner = _make_claude_runner(captured_context, captured_kwargs)
        executor = _make_executor(task, db)
        rm = _make_resource_manager()

        await executor._run_execution(task=task, claude_runner=runner, resource_manager=rm)

        # folder_prompt가 system_prompt로 주입되어야 함
        system_prompt = captured_kwargs.get("system_prompt")
        assert system_prompt is not None
        assert "항상 한국어로 답하세요." in system_prompt

    @pytest.mark.asyncio
    @patch("soul_server.service.task_executor.build_soulstream_context_item",
           return_value={"key": "soulstream_session", "content": {}})
    @patch("soul_server.service.task_executor.assemble_prompt",
           return_value="assembled prompt")
    @patch("soul_server.service.task_executor.get_session_broadcaster")
    async def test_folder_prompt_not_injected_for_resume(
        self, mock_broadcaster, mock_assemble, mock_build_ctx
    ):
        """resume 세션에서는 folderPrompt가 있어도 system_prompt에 주입하지 않는다."""
        mock_broadcaster.return_value = MagicMock(
            emit_session_updated=AsyncMock(),
            emit_session_message_updated=AsyncMock(),
        )

        db = _make_db(folder_settings={"folderPrompt": "항상 한국어로 답하세요."})
        task = _make_task(resume_session_id="prev-claude-session-id")  # resume 세션

        captured_context: list = []
        captured_kwargs: dict = {}
        runner = _make_claude_runner(captured_context, captured_kwargs)
        executor = _make_executor(task, db)
        rm = _make_resource_manager()

        await executor._run_execution(task=task, claude_runner=runner, resource_manager=rm)

        # resume 세션에서는 system_prompt에 folder_prompt가 포함되지 않아야 함
        system_prompt = captured_kwargs.get("system_prompt")
        if system_prompt:
            assert "항상 한국어로 답하세요." not in system_prompt

    @pytest.mark.asyncio
    @patch("soul_server.service.task_executor.build_soulstream_context_item",
           return_value={"key": "soulstream_session", "content": {}})
    @patch("soul_server.service.task_executor.assemble_prompt",
           return_value="assembled prompt")
    @patch("soul_server.service.task_executor.get_session_broadcaster")
    async def test_folder_prompt_not_injected_when_empty(
        self, mock_broadcaster, mock_assemble, mock_build_ctx
    ):
        """folderPrompt가 빈 문자열이면 system_prompt에 주입하지 않는다."""
        mock_broadcaster.return_value = MagicMock(
            emit_session_updated=AsyncMock(),
            emit_session_message_updated=AsyncMock(),
        )

        db = _make_db(folder_settings={"folderPrompt": ""})  # 빈 문자열
        task = _make_task(resume_session_id=None)

        captured_context: list = []
        captured_kwargs: dict = {}
        runner = _make_claude_runner(captured_context, captured_kwargs)
        executor = _make_executor(task, db)
        rm = _make_resource_manager()

        await executor._run_execution(task=task, claude_runner=runner, resource_manager=rm)

        # 빈 folderPrompt는 system_prompt에 포함되지 않아야 함
        system_prompt = captured_kwargs.get("system_prompt")
        # system_prompt가 None이거나, 있더라도 빈 폴더 프롬프트는 불포함
        assert system_prompt is None or system_prompt == ""

    @pytest.mark.asyncio
    @patch("soul_server.service.task_executor.build_soulstream_context_item",
           return_value={"key": "soulstream_session", "content": {}})
    @patch("soul_server.service.task_executor.assemble_prompt",
           return_value="assembled prompt")
    @patch("soul_server.service.task_executor.get_session_broadcaster")
    async def test_folder_prompt_not_injected_when_settings_missing(
        self, mock_broadcaster, mock_assemble, mock_build_ctx
    ):
        """folder_row에 settings 컬럼이 없어도 에러 없이 동작한다 (SQLite 방어)."""
        mock_broadcaster.return_value = MagicMock(
            emit_session_updated=AsyncMock(),
            emit_session_message_updated=AsyncMock(),
        )

        db = _make_db(folder_settings=None)  # settings = None (SQLite 모드)
        task = _make_task(resume_session_id=None)

        captured_context: list = []
        captured_kwargs: dict = {}
        runner = _make_claude_runner(captured_context, captured_kwargs)
        executor = _make_executor(task, db)
        rm = _make_resource_manager()

        # 에러 없이 완료되어야 함
        await executor._run_execution(task=task, claude_runner=runner, resource_manager=rm)

        # settings가 없으면 system_prompt에 folder_prompt가 없어야 함
        system_prompt = captured_kwargs.get("system_prompt")
        assert system_prompt is None or system_prompt == ""
