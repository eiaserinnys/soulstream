"""service/intervention_service.py 단위 테스트.

intervene와 respond_to_input의 비즈니스 로직을 Mock으로 검증한다.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from soul_server.service.intervention_service import (
    InputRequestNotPendingError,
    intervene,
    respond_to_input,
)
from soul_server.service.task_manager import (
    NodeMismatchError,
    TaskNotFoundError,
    TaskNotRunningError,
)


# ============================================================================
# intervene
# ============================================================================


class TestIntervene:
    async def test_auto_resumed_calls_start_execution(self):
        tm = MagicMock()
        tm.add_intervention = AsyncMock(return_value={"auto_resumed": True})
        tm.executor.start_execution = AsyncMock()
        engine = MagicMock()
        rm = MagicMock()

        result = await intervene(
            "sess-1", "hello", "user-a", attachment_paths=None,
            task_manager=tm, soul_engine=engine, resource_manager=rm,
        )

        assert result == {"auto_resumed": True, "agent_session_id": "sess-1"}
        tm.executor.start_execution.assert_awaited_once_with(
            agent_session_id="sess-1",
            claude_runner=engine,
            resource_manager=rm,
        )

    async def test_queued_returns_queue_position(self):
        tm = MagicMock()
        tm.add_intervention = AsyncMock(return_value={"queue_position": 3})
        tm.executor.start_execution = AsyncMock()
        engine = MagicMock()
        rm = MagicMock()

        result = await intervene(
            "sess-2", "hi", "user-b", attachment_paths=["/tmp/a.png"],
            task_manager=tm, soul_engine=engine, resource_manager=rm,
        )

        assert result == {"queued": True, "queue_position": 3}
        tm.executor.start_execution.assert_not_called()

    async def test_node_mismatch_propagates(self):
        tm = MagicMock()
        tm.add_intervention = AsyncMock(
            side_effect=NodeMismatchError(session_node_id="A", current_node_id="B")
        )
        engine = MagicMock()
        rm = MagicMock()

        with pytest.raises(NodeMismatchError):
            await intervene(
                "sess-3", "x", "u", attachment_paths=None,
                task_manager=tm, soul_engine=engine, resource_manager=rm,
            )

    async def test_task_not_found_propagates(self):
        tm = MagicMock()
        tm.add_intervention = AsyncMock(side_effect=TaskNotFoundError("missing"))
        engine = MagicMock()
        rm = MagicMock()

        with pytest.raises(TaskNotFoundError):
            await intervene(
                "sess-4", "x", "u", attachment_paths=None,
                task_manager=tm, soul_engine=engine, resource_manager=rm,
            )

    async def test_attachment_paths_none_normalized_to_empty_list(self):
        tm = MagicMock()
        tm.add_intervention = AsyncMock(return_value={"queue_position": 0})
        engine = MagicMock()
        rm = MagicMock()

        await intervene(
            "sess-5", "x", "u", attachment_paths=None,
            task_manager=tm, soul_engine=engine, resource_manager=rm,
        )

        # add_intervention가 attachment_paths=[]로 호출되었는지 확인
        kwargs = tm.add_intervention.await_args.kwargs
        assert kwargs["attachment_paths"] == []

    async def test_attachment_paths_passthrough(self):
        tm = MagicMock()
        tm.add_intervention = AsyncMock(return_value={"queue_position": 0})
        engine = MagicMock()
        rm = MagicMock()

        paths = ["/a.png", "/b.pdf"]
        await intervene(
            "sess-6", "x", "u", attachment_paths=paths,
            task_manager=tm, soul_engine=engine, resource_manager=rm,
        )

        kwargs = tm.add_intervention.await_args.kwargs
        assert kwargs["attachment_paths"] == paths

    async def test_context_items_passthrough(self):
        tm = MagicMock()
        tm.add_intervention = AsyncMock(return_value={"queue_position": 0})
        engine = MagicMock()
        rm = MagicMock()
        context_items = [
            {"key": "attachments", "label": "첨부 파일", "content": "파일: map.png"},
        ]

        await intervene(
            "sess-7", "x", "u", attachment_paths=None,
            context_items=context_items,
            task_manager=tm, soul_engine=engine, resource_manager=rm,
        )

        kwargs = tm.add_intervention.await_args.kwargs
        assert kwargs["extra_context_items"] == context_items


# ============================================================================
# respond_to_input
# ============================================================================


class TestRespondToInput:
    async def test_success_returns_delivered_dict(self):
        tm = MagicMock()
        tm.deliver_input_response = MagicMock(return_value=True)

        result = await respond_to_input(
            "sess-1", "req-abc", answers={"choice": 1},
            task_manager=tm,
        )

        assert result == {"delivered": True, "request_id": "req-abc"}
        tm.deliver_input_response.assert_called_once_with(
            agent_session_id="sess-1",
            request_id="req-abc",
            answers={"choice": 1},
        )

    async def test_not_pending_raises_input_request_not_pending(self):
        tm = MagicMock()
        tm.deliver_input_response = MagicMock(return_value=False)

        with pytest.raises(InputRequestNotPendingError) as exc:
            await respond_to_input(
                "sess-2", "req-stale", answers={"choice": 0},
                task_manager=tm,
            )

        # request_id가 예외에 보존되는지 확인 (라우트가 422 메시지에 사용)
        assert exc.value.request_id == "req-stale"

    async def test_task_not_found_propagates(self):
        tm = MagicMock()
        tm.deliver_input_response = MagicMock(side_effect=TaskNotFoundError("nope"))

        with pytest.raises(TaskNotFoundError):
            await respond_to_input(
                "sess-3", "req", answers={},
                task_manager=tm,
            )

    async def test_task_not_running_propagates(self):
        tm = MagicMock()
        tm.deliver_input_response = MagicMock(side_effect=TaskNotRunningError("nope"))

        with pytest.raises(TaskNotRunningError):
            await respond_to_input(
                "sess-4", "req", answers={},
                task_manager=tm,
            )
