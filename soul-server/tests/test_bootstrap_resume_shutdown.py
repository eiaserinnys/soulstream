"""resume_shutdown_sessions 회귀 테스트 — F-11D system caller_info forward.

server 재시작 안내 인터벤션이 source="system" caller_info를 박아 클라이언트가
시스템 발신을 정확히 식별하는지 검증한다 (이전엔 caller_info=None → dashboard owner
portrait fallback 결함).
"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock

from soul_server.bootstrap import resume_shutdown_sessions


def _make_settings(node_id: str = "test-node"):
    settings = MagicMock()
    settings.soulstream_node_id = node_id
    return settings


@pytest.mark.asyncio
class TestResumeShutdownSessionsCallerInfo:
    """F-11D 핵심: resume_shutdown_sessions이 add_intervention 호출 시 system caller_info 박는다."""

    async def test_no_shutdown_sessions_skip(self):
        """저장된 종료 세션이 없으면 add_intervention/clear_shutdown_flags 모두 미호출.

        get_shutdown_sessions 빈 목록 시 early return → finally(clear_shutdown_flags)
        미도달. 본 단언이 빠지면 향후 early return 제거 회귀가 침묵 통과한다.
        """
        session_db = MagicMock()
        session_db.get_shutdown_sessions = AsyncMock(return_value=[])
        session_db.clear_shutdown_flags = AsyncMock()

        tm = MagicMock()
        tm.add_intervention = AsyncMock()

        await resume_shutdown_sessions(session_db, tm, _make_settings())

        tm.add_intervention.assert_not_called()
        session_db.clear_shutdown_flags.assert_not_called()

    async def test_single_session_resume_includes_system_caller_info(self):
        """단일 종료 세션 resume 시 add_intervention의 caller_info가 system v1 dict."""
        session_db = MagicMock()
        session_db.get_shutdown_sessions = AsyncMock(
            return_value=[{"session_id": "sess-1"}]
        )
        session_db.clear_shutdown_flags = AsyncMock()

        tm = MagicMock()
        tm.add_intervention = AsyncMock(return_value={"queue_position": 0})
        tm.executor = MagicMock()
        tm.executor.start_execution = AsyncMock()

        await resume_shutdown_sessions(session_db, tm, _make_settings(node_id="node-X"))

        tm.add_intervention.assert_called_once()
        call = tm.add_intervention.call_args
        assert call.args == (
            "sess-1",
            "소울스트림 서버 재시작이 완료되었습니다. 이전에 진행하던 작업을 재개해주세요.",
        )
        assert call.kwargs["user"] == "system"
        ci = call.kwargs["caller_info"]
        assert ci == {
            "source": "system",
            "agent_node": "node-X",
            "display_name": "Soulstream",
            "user_id": None,
            "avatar_url": None,
        }
        session_db.clear_shutdown_flags.assert_called_once()

    async def test_auto_resumed_starts_execution(self):
        """add_intervention 결과가 auto_resumed면 start_execution 호출."""
        session_db = MagicMock()
        session_db.get_shutdown_sessions = AsyncMock(
            return_value=[{"session_id": "sess-1"}]
        )
        session_db.clear_shutdown_flags = AsyncMock()

        tm = MagicMock()
        tm.add_intervention = AsyncMock(return_value={"auto_resumed": True})
        tm.executor = MagicMock()
        tm.executor.start_execution = AsyncMock()

        await resume_shutdown_sessions(session_db, tm, _make_settings())

        tm.executor.start_execution.assert_called_once()
        assert tm.executor.start_execution.call_args.kwargs["agent_session_id"] == "sess-1"
