"""TaskExecutor._update_and_broadcast_last_message() 단위 테스트"""
import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from soul_server.service.task_executor import TaskExecutor
from soul_server.service.task_models import Task, TaskStatus


def _make_executor(catalog=None):
    """테스트용 TaskExecutor 생성"""
    return TaskExecutor(
        tasks={},
        listener_manager=MagicMock(),
        get_intervention_func=AsyncMock(),
        complete_task_func=AsyncMock(),
        error_task_func=AsyncMock(),
        catalog=catalog,
    )


def _make_task(session_id="test-session", status=TaskStatus.RUNNING):
    """테스트용 Task 생성"""
    task = MagicMock(spec=Task)
    task.agent_session_id = session_id
    task.status = status
    return task


class TestUpdateAndBroadcastLastMessage:
    """_update_and_broadcast_last_message() 단위 테스트"""

    @patch("soul_server.service.task_executor.get_session_broadcaster")
    async def test_readable_event_triggers_last_message_broadcast(
        self, mock_get_broadcaster
    ):
        """text 이벤트가 catalog.update_last_message와 emit_session_message_updated를 호출한다"""
        catalog = MagicMock()
        broadcaster = MagicMock()
        broadcaster.emit_session_message_updated = AsyncMock()
        mock_get_broadcaster.return_value = broadcaster

        executor = _make_executor(catalog=catalog)
        task = _make_task()

        event = {"type": "text", "text": "hello", "timestamp": "2024-01-01T00:00:00Z"}
        await executor._update_and_broadcast_last_message("test-session", event, task)

        catalog.update_last_message.assert_called_once_with(
            "test-session", "text", "hello", "2024-01-01T00:00:00Z"
        )
        broadcaster.emit_session_message_updated.assert_called_once()
        call_kwargs = broadcaster.emit_session_message_updated.call_args.kwargs
        assert call_kwargs["agent_session_id"] == "test-session"
        assert call_kwargs["last_message"]["type"] == "text"
        assert call_kwargs["last_message"]["preview"] == "hello"

    @patch("soul_server.service.task_executor.get_session_broadcaster")
    async def test_user_message_triggers_last_message_broadcast(
        self, mock_get_broadcaster
    ):
        """user_message 이벤트의 text가 preview로 사용된다"""
        catalog = MagicMock()
        broadcaster = MagicMock()
        broadcaster.emit_session_message_updated = AsyncMock()
        mock_get_broadcaster.return_value = broadcaster

        executor = _make_executor(catalog=catalog)
        task = _make_task()

        event = {"type": "user_message", "text": "my prompt"}
        await executor._update_and_broadcast_last_message("test-session", event, task)

        catalog.update_last_message.assert_called_once()
        args = catalog.update_last_message.call_args
        assert args[0][0] == "test-session"
        assert args[0][1] == "user_message"
        assert args[0][2] == "my prompt"

    @patch("soul_server.service.task_executor.get_session_broadcaster")
    async def test_complete_event_triggers_last_message_broadcast(
        self, mock_get_broadcaster
    ):
        """complete 이벤트의 result가 preview로 사용된다"""
        catalog = MagicMock()
        broadcaster = MagicMock()
        broadcaster.emit_session_message_updated = AsyncMock()
        mock_get_broadcaster.return_value = broadcaster

        executor = _make_executor(catalog=catalog)
        task = _make_task()

        event = {"type": "complete", "result": "done"}
        await executor._update_and_broadcast_last_message("test-session", event, task)

        catalog.update_last_message.assert_called_once()
        args = catalog.update_last_message.call_args
        assert args[0][2] == "done"

    @patch("soul_server.service.task_executor.get_session_broadcaster")
    async def test_intervention_sent_triggers_last_message_broadcast(
        self, mock_get_broadcaster
    ):
        """intervention_sent 이벤트의 text가 preview로 사용된다"""
        catalog = MagicMock()
        broadcaster = MagicMock()
        broadcaster.emit_session_message_updated = AsyncMock()
        mock_get_broadcaster.return_value = broadcaster

        executor = _make_executor(catalog=catalog)
        task = _make_task()

        event = {"type": "intervention_sent", "text": "intervened"}
        await executor._update_and_broadcast_last_message("test-session", event, task)

        catalog.update_last_message.assert_called_once()
        args = catalog.update_last_message.call_args
        assert args[0][1] == "intervention_sent"
        assert args[0][2] == "intervened"

    @patch("soul_server.service.task_executor.get_session_broadcaster")
    async def test_non_readable_event_skips_broadcast(
        self, mock_get_broadcaster
    ):
        """PREVIEW_FIELD_MAP에 없는 이벤트는 catalog.update_last_message를 호출하지 않는다"""
        catalog = MagicMock()
        executor = _make_executor(catalog=catalog)
        task = _make_task()

        event = {"type": "session", "session_id": "xxx"}
        await executor._update_and_broadcast_last_message("test-session", event, task)

        catalog.update_last_message.assert_not_called()
        mock_get_broadcaster.assert_not_called()

    @patch("soul_server.service.task_executor.get_session_broadcaster")
    async def test_empty_text_skips_broadcast(
        self, mock_get_broadcaster
    ):
        """text가 빈 이벤트에서는 catalog.update_last_message가 호출되지 않는다"""
        catalog = MagicMock()
        executor = _make_executor(catalog=catalog)
        task = _make_task()

        event = {"type": "text", "text": ""}
        await executor._update_and_broadcast_last_message("test-session", event, task)

        catalog.update_last_message.assert_not_called()
        mock_get_broadcaster.assert_not_called()

    @patch("soul_server.service.task_executor.get_session_broadcaster")
    async def test_broadcaster_not_ready_does_not_crash(
        self, mock_get_broadcaster
    ):
        """broadcaster가 예외를 던져도 크래시하지 않고 catalog는 정상 업데이트된다"""
        catalog = MagicMock()
        mock_get_broadcaster.side_effect = Exception("broadcaster not ready")

        executor = _make_executor(catalog=catalog)
        task = _make_task()

        event = {"type": "text", "text": "hello", "timestamp": "2024-01-01T00:00:00Z"}
        # 예외 없이 정상 반환해야 한다
        await executor._update_and_broadcast_last_message("test-session", event, task)

        # catalog는 broadcaster 예외와 무관하게 업데이트된다
        catalog.update_last_message.assert_called_once()

    async def test_catalog_none_skips_silently(self):
        """catalog가 None이면 에러 없이 즉시 반환한다"""
        executor = _make_executor(catalog=None)
        task = _make_task()

        event = {"type": "text", "text": "hello", "timestamp": "2024-01-01T00:00:00Z"}
        # 예외 없이 정상 반환해야 한다
        await executor._update_and_broadcast_last_message("test-session", event, task)
