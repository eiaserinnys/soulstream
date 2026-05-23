from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from soul_server.service.task_manager import TaskManager
from soul_server.service.task_models import Task, TaskNotRunningError, TaskStatus


def _make_mock_db():
    db = MagicMock()
    db.node_id = "test-node"
    db.update_session = AsyncMock()
    db.get_all_sessions = AsyncMock(return_value=([], 0))
    db.get_session = AsyncMock(return_value=None)
    db.DEFAULT_FOLDERS = {"claude": "⚙️", "llm": "⚙️"}
    return db


@pytest.mark.asyncio
async def test_interrupt_task_marks_interrupted_and_calls_runner():
    db = _make_mock_db()
    manager = TaskManager(session_db=db)
    task = Task(agent_session_id="sess-stop", prompt="hi", status=TaskStatus.RUNNING)
    runner = MagicMock()
    runner.interrupt.return_value = True
    task._runner = runner
    manager._tasks[task.agent_session_id] = task

    broadcaster = MagicMock()
    broadcaster.emit_session_updated = AsyncMock()
    with patch(
        "soul_server.service.task_manager.get_session_broadcaster",
        return_value=broadcaster,
    ):
        interrupted = await manager.interrupt_task(task.agent_session_id)

    assert interrupted is True
    assert task.status == TaskStatus.INTERRUPTED
    runner.interrupt.assert_called_once_with()
    db.update_session.assert_awaited_once()
    assert db.update_session.call_args.kwargs["status"] == TaskStatus.INTERRUPTED.value
    broadcaster.emit_session_updated.assert_awaited_once_with(task)


@pytest.mark.asyncio
async def test_interrupt_task_rejects_terminal_session():
    manager = TaskManager(session_db=_make_mock_db())
    task = Task(
        agent_session_id="sess-done",
        prompt="hi",
        status=TaskStatus.COMPLETED,
    )
    manager._tasks[task.agent_session_id] = task

    with pytest.raises(TaskNotRunningError):
        await manager.interrupt_task(task.agent_session_id)
