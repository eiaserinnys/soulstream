"""test_session_broadcaster_caller_source — R-2 emit_session_created caller_source 회귀.

R-2 fix(2026-05-10) — atom 0499ee7b (G-2):
- `emit_session_created`가 top-level `caller_source` 키를 wire에 박는다.
- emit_session_updated / emit_session_phase와 §9 대칭.
- orch `_on_node_change`가 이 키를 읽어 `apply_user_profile_enrichment`에 forward,
  정체성 명시 source가 dashboard owner Google portrait로 덮이지 않게 한다.

wire 키 정본: atom b558ca3b.
"""
from datetime import datetime, timezone

import pytest

from soul_server.service.session_broadcaster import SessionBroadcaster
from soul_server.service.task_models import Task, TaskStatus


@pytest.fixture
def mock_registry():
    """간단한 AgentRegistry stub — _resolve_agent_info에서 사용."""
    class _StubRegistry:
        def get(self, profile_id):
            return None
    return _StubRegistry()


def _make_task(caller_info: dict | None) -> Task:
    return Task(
        agent_session_id="sess-r2-created-caller",
        prompt="테스트",
        status=TaskStatus.RUNNING,
        last_progress_text="...",
        last_assistant_text=None,
        completed_at=None,
        session_type="claude",
        caller_info=caller_info,
    )


class TestEmitSessionCreatedCallerSource:
    @pytest.mark.parametrize(
        "source",
        ["agent", "system", "slack", "soul-app", "browser", "api"],
    )
    async def test_emit_session_created_propagates_caller_source(self, mock_registry, source):
        """모든 v1 source가 wire의 top-level caller_source로 promote된다."""
        broadcaster = SessionBroadcaster(agent_registry=mock_registry)
        queue = broadcaster.add_client()
        await broadcaster.emit_session_created(
            _make_task({"source": source}), folder_id="folder-1",
        )
        _eid, event = queue.get_nowait()
        assert event["caller_source"] == source

    async def test_emit_session_created_caller_info_none_yields_none_source(self, mock_registry):
        """task.caller_info=None → top-level caller_source 키는 존재하지만 값 None.

        wire 일관성 — 키 자체는 emit_session_updated/phase와 대칭으로 항상 존재.
        클라이언트(orch _on_node_change)가 .get('caller_source')로 None 받아 fallback.
        """
        broadcaster = SessionBroadcaster(agent_registry=mock_registry)
        queue = broadcaster.add_client()
        await broadcaster.emit_session_created(_make_task(None), folder_id=None)
        _eid, event = queue.get_nowait()
        assert "caller_source" in event
        assert event["caller_source"] is None
