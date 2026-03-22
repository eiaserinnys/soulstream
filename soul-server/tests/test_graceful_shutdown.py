"""
test_graceful_shutdown - graceful_shutdown 함수 유닛 테스트

전역 상태(_is_draining) 격리를 위해 autouse fixture를 사용합니다.

커버리지 시나리오:
- 활성 세션 0개: DB 플래그 설정 (빈 목록), intervention 미호출
- 활성 세션 N개: DB 플래그 설정 + intervention(skip_resume=True) 전송 + 완료 대기
- 예외 발생: DB 플래그 정리 + _is_draining=False 복원
- 이중 호출 가드: 두 번째 호출은 즉시 반환
"""

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import soul_server.main as main_module
from soul_server.main import graceful_shutdown


@pytest.fixture(autouse=True)
def mock_session_db():
    """get_session_db를 모킹하여 PostgresSessionDB 의존성을 제거한다."""
    mock_db = MagicMock()
    mock_db.mark_running_at_shutdown = AsyncMock()
    mock_db.clear_shutdown_flags = AsyncMock()
    with patch("soul_server.main.get_session_db", return_value=mock_db):
        yield mock_db


@pytest.fixture(autouse=True)
def reset_is_draining():
    """각 테스트 전후로 _is_draining 전역 상태를 False로 초기화한다."""
    main_module._is_draining = False
    yield
    main_module._is_draining = False


def make_task(session_id: str, claude_session_id: str = None) -> MagicMock:
    """Task mock 생성 헬퍼."""
    task = MagicMock()
    task.agent_session_id = session_id
    task.claude_session_id = claude_session_id or f"claude-{session_id}"
    return task


class TestGracefulShutdownNoSessions:
    """활성 세션 0개 시나리오."""

    async def test_empty_sessions_marks_empty_in_db(self, mock_session_db):
        """활성 세션이 없으면 DB에 빈 목록으로 mark_running_at_shutdown을 호출한다."""
        tm = MagicMock()
        tm.get_running_tasks.return_value = []
        tm.add_intervention = AsyncMock()
        tm.cancel_running_tasks = AsyncMock()

        await graceful_shutdown(tm)

        mock_session_db.mark_running_at_shutdown.assert_called_once_with([])

    async def test_empty_sessions_no_intervention(self, mock_session_db):
        """활성 세션이 없으면 add_intervention을 호출하지 않는다."""
        tm = MagicMock()
        tm.get_running_tasks.return_value = []
        tm.add_intervention = AsyncMock()

        await graceful_shutdown(tm)

        tm.add_intervention.assert_not_called()


class TestGracefulShutdownActiveSessions:
    """활성 세션 N개 시나리오."""

    async def test_active_sessions_marked_in_db(self, mock_session_db):
        """활성 세션 ID를 DB에 mark_running_at_shutdown으로 기록한다."""
        task1 = make_task("sess-1", "claude-abc")
        task2 = make_task("sess-2", "claude-def")

        tm = MagicMock()
        # 1번째(세션 목록 수집) → 2번째(대기 루프) → 3번째(강제 취소 체크)
        tm.get_running_tasks.side_effect = [[task1, task2], [], []]
        tm.add_intervention = AsyncMock()
        tm.cancel_running_tasks = AsyncMock()

        await graceful_shutdown(tm)

        mock_session_db.mark_running_at_shutdown.assert_called_once_with(
            ["sess-1", "sess-2"]
        )

    async def test_intervention_sent_with_skip_resume(self, mock_session_db):
        """단일 활성 세션에 skip_resume=True로 add_intervention을 호출한다."""
        task1 = make_task("sess-1")

        tm = MagicMock()
        tm.get_running_tasks.side_effect = [[task1], [], []]
        tm.add_intervention = AsyncMock()
        tm.cancel_running_tasks = AsyncMock()

        await graceful_shutdown(tm)

        tm.add_intervention.assert_called_with(
            "sess-1",
            "소울스트림 서버가 재시작될 예정입니다. 현재 작업을 중단하고 대기해주세요.",
            user="system",
            skip_resume=True,
        )

    async def test_multiple_sessions_all_receive_intervention(self, mock_session_db):
        """여러 활성 세션 모두에 intervention이 전송된다."""
        tasks = [make_task(f"sess-{i}") for i in range(3)]

        tm = MagicMock()
        tm.get_running_tasks.side_effect = [tasks, [], []]
        tm.add_intervention = AsyncMock()
        tm.cancel_running_tasks = AsyncMock()

        await graceful_shutdown(tm)

        assert tm.add_intervention.call_count == 3
        for c in tm.add_intervention.call_args_list:
            assert c.kwargs["skip_resume"] is True


class TestGracefulShutdownExceptionRecovery:
    """예외 발생 시 복원 시나리오."""

    async def test_exception_clears_flags_and_restores_draining(self, mock_session_db):
        """예외 발생 시 DB 플래그를 정리하고 _is_draining을 False로 복원한다."""
        task1 = make_task("sess-1")

        tm = MagicMock()
        # 처음에는 세션 반환 → DB 플래그 설정 → 대기 루프 진입 → asyncio.sleep에서 예외
        tm.get_running_tasks.return_value = [task1]
        tm.add_intervention = AsyncMock()

        async def raise_error(*args, **kwargs):
            raise RuntimeError("unexpected error")

        with patch("asyncio.sleep", side_effect=raise_error):
            with pytest.raises(RuntimeError, match="unexpected error"):
                await graceful_shutdown(tm)

        # DB 플래그가 정리되었는지 확인
        mock_session_db.clear_shutdown_flags.assert_called_once()

        # _is_draining이 False로 복원되었는지 확인
        assert main_module._is_draining is False


class TestGracefulShutdownDoubleCallGuard:
    """이중 호출 가드 시나리오."""

    async def test_second_call_returns_immediately(self, mock_session_db):
        """이미 draining 중이면 두 번째 호출은 즉시 반환하고 get_running_tasks를 추가 호출하지 않는다."""
        tm = MagicMock()
        tm.get_running_tasks.return_value = []
        tm.add_intervention = AsyncMock()

        # 첫 번째 호출
        await graceful_shutdown(tm)
        assert main_module._is_draining is True

        # 첫 번째 호출의 카운트를 초기화하고 두 번째 호출 시 추가 호출이 없는지 검증
        tm.get_running_tasks.reset_mock()

        # 두 번째 호출 (즉시 반환)
        await graceful_shutdown(tm)

        # 두 번째 호출에서는 get_running_tasks가 호출되지 않아야 함
        assert tm.get_running_tasks.call_count == 0
