"""
test_graceful_shutdown - graceful_shutdown 함수 유닛 테스트

app.state.is_draining 기반 격리를 위해 autouse fixture를 사용합니다.

커버리지 시나리오:
- 활성 세션 0개: DB 플래그 설정 (빈 목록), intervention 미호출
- 활성 세션 N개: DB 플래그 설정 + intervention(skip_resume=True) 전송 + 완료 대기
- 예외 발생: DB 플래그 정리 + is_draining=False 복원
- 이중 호출 가드: 두 번째 호출은 즉시 반환
"""

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from soul_server.main import graceful_shutdown


def make_mock_app():
    """graceful_shutdown에 전달할 mock FastAPI app을 생성한다."""
    app = MagicMock()
    app.state.is_draining = False
    return app


@pytest.fixture(autouse=True)
def mock_session_db():
    """get_session_db를 모킹하여 PostgresSessionDB 의존성을 제거한다."""
    mock_db = MagicMock()
    mock_db.mark_running_at_shutdown = AsyncMock()
    mock_db.clear_shutdown_flags = AsyncMock()
    with patch("soul_server.main.get_session_db", return_value=mock_db):
        yield mock_db


@pytest.fixture(autouse=True)
def mock_query_service():
    """get_session_query_service를 모킹한다.

    각 테스트에서 tm.get_running_tasks를 설정하면 graceful_shutdown 내부에서
    get_session_query_service().get_running_tasks()로 동일 mock이 반환된다.
    """
    mock_svc = MagicMock()
    mock_svc.get_running_tasks.return_value = []
    with patch("soul_server.main.get_session_query_service", return_value=mock_svc):
        yield mock_svc


def make_task(session_id: str, claude_session_id: str = None) -> MagicMock:
    """Task mock 생성 헬퍼."""
    task = MagicMock()
    task.agent_session_id = session_id
    task.claude_session_id = claude_session_id or f"claude-{session_id}"
    return task


class TestGracefulShutdownNoSessions:
    """활성 세션 0개 시나리오."""

    async def test_empty_sessions_marks_empty_in_db(self, mock_session_db, mock_query_service):
        """활성 세션이 없으면 DB에 빈 목록으로 mark_running_at_shutdown을 호출한다."""
        app = make_mock_app()
        tm = MagicMock()
        tm.add_intervention = AsyncMock()
        tm.cancel_running_tasks = AsyncMock()
        mock_query_service.get_running_tasks.return_value = []

        await graceful_shutdown(app, tm)

        mock_session_db.mark_running_at_shutdown.assert_called_once_with([])

    async def test_empty_sessions_no_intervention(self, mock_session_db, mock_query_service):
        """활성 세션이 없으면 add_intervention을 호출하지 않는다."""
        app = make_mock_app()
        tm = MagicMock()
        tm.add_intervention = AsyncMock()
        mock_query_service.get_running_tasks.return_value = []

        await graceful_shutdown(app, tm)

        tm.add_intervention.assert_not_called()


class TestGracefulShutdownActiveSessions:
    """활성 세션 N개 시나리오."""

    async def test_active_sessions_marked_in_db(self, mock_session_db, mock_query_service):
        """활성 세션 ID를 DB에 mark_running_at_shutdown으로 기록한다."""
        app = make_mock_app()
        task1 = make_task("sess-1", "claude-abc")
        task2 = make_task("sess-2", "claude-def")

        tm = MagicMock()
        # 1번째(세션 목록 수집) → 2번째(대기 루프) → 3번째(강제 취소 체크)
        mock_query_service.get_running_tasks.side_effect = [[task1, task2], [], []]
        tm.add_intervention = AsyncMock()
        tm.cancel_running_tasks = AsyncMock()

        await graceful_shutdown(app, tm)

        mock_session_db.mark_running_at_shutdown.assert_called_once_with(
            ["sess-1", "sess-2"]
        )

    async def test_intervention_sent_with_skip_resume(self, mock_session_db, mock_query_service):
        """단일 활성 세션에 skip_resume=True + system caller_info로 add_intervention을 호출한다.

        F-11D fix(2026-05-09, atom F-11): caller_info에 source="system" 박아 시스템 발신
        식별자를 wire에 담는다.
        """
        from soul_server.main import settings as _main_settings

        app = make_mock_app()
        task1 = make_task("sess-1")

        tm = MagicMock()
        mock_query_service.get_running_tasks.side_effect = [[task1], [], []]
        tm.add_intervention = AsyncMock()
        tm.cancel_running_tasks = AsyncMock()

        await graceful_shutdown(app, tm)

        tm.add_intervention.assert_called_once()
        call = tm.add_intervention.call_args
        assert call.args == (
            "sess-1",
            "소울스트림 서버가 재시작될 예정입니다. 현재 작업을 중단하고 대기해주세요.",
        )
        assert call.kwargs["user"] == "system"
        assert call.kwargs["skip_resume"] is True
        ci = call.kwargs["caller_info"]
        assert ci is not None
        assert ci["source"] == "system"
        assert ci["display_name"] == "Soulstream"
        assert ci["agent_node"] == _main_settings.soulstream_node_id
        assert ci["user_id"] is None
        assert ci["avatar_url"] is None

    async def test_multiple_sessions_all_receive_intervention(self, mock_session_db, mock_query_service):
        """여러 활성 세션 모두에 intervention이 전송된다."""
        app = make_mock_app()
        tasks = [make_task(f"sess-{i}") for i in range(3)]

        tm = MagicMock()
        mock_query_service.get_running_tasks.side_effect = [tasks, [], []]
        tm.add_intervention = AsyncMock()
        tm.cancel_running_tasks = AsyncMock()

        await graceful_shutdown(app, tm)

        assert tm.add_intervention.call_count == 3
        for c in tm.add_intervention.call_args_list:
            assert c.kwargs["skip_resume"] is True


class TestGracefulShutdownExceptionRecovery:
    """예외 발생 시 복원 시나리오."""

    async def test_exception_clears_flags_and_restores_draining(self, mock_session_db, mock_query_service):
        """예외 발생 시 DB 플래그를 정리하고 is_draining을 False로 복원한다."""
        app = make_mock_app()
        task1 = make_task("sess-1")

        tm = MagicMock()
        # 처음에는 세션 반환 → DB 플래그 설정 → 대기 루프 진입 → asyncio.sleep에서 예외
        mock_query_service.get_running_tasks.return_value = [task1]
        tm.add_intervention = AsyncMock()

        async def raise_error(*args, **kwargs):
            raise RuntimeError("unexpected error")

        with patch("asyncio.sleep", side_effect=raise_error):
            with pytest.raises(RuntimeError, match="unexpected error"):
                await graceful_shutdown(app, tm)

        # DB 플래그가 정리되었는지 확인
        mock_session_db.clear_shutdown_flags.assert_called_once()

        # is_draining이 False로 복원되었는지 확인
        assert app.state.is_draining is False


class TestGracefulShutdownSessionDbError:
    """get_session_db() 실패 시나리오."""

    async def test_session_db_unavailable_propagates_without_name_error(self, mock_query_service):
        """get_session_db()가 예외를 던지면 NameError 없이 원래 예외가 전파되어야 한다."""
        app = make_mock_app()
        tm = MagicMock()
        mock_query_service.get_running_tasks.return_value = [make_task("sess-1")]
        tm.add_intervention = AsyncMock()

        # autouse mock_session_db fixture의 patch를 RuntimeError로 override
        caught_exc = None
        with patch(
            "soul_server.main.get_session_db",
            side_effect=RuntimeError("db unavailable"),
        ):
            try:
                await graceful_shutdown(app, tm)
            except (RuntimeError, NameError) as e:
                caught_exc = e

        assert caught_exc is not None, "graceful_shutdown이 예외를 발생시켜야 한다"

        # GREEN 조건: NameError가 아닌 원래 RuntimeError가 전파되어야 한다
        assert isinstance(caught_exc, RuntimeError), (
            f"NameError가 발생했습니다 (버그): except 블록에서 session_db가 "
            f"미할당 상태로 참조됩니다. 발생한 예외: {type(caught_exc).__name__}: {caught_exc}"
        )

        # is_draining이 False로 복원되어야 한다
        assert app.state.is_draining is False


class TestGracefulShutdownDoubleCallGuard:
    """이중 호출 가드 시나리오."""

    async def test_second_call_returns_immediately(self, mock_session_db, mock_query_service):
        """이미 draining 중이면 두 번째 호출은 즉시 반환하고 get_running_tasks를 추가 호출하지 않는다."""
        app = make_mock_app()
        tm = MagicMock()
        mock_query_service.get_running_tasks.return_value = []
        tm.add_intervention = AsyncMock()

        # 첫 번째 호출
        await graceful_shutdown(app, tm)
        assert app.state.is_draining is True

        # 첫 번째 호출의 카운트를 초기화하고 두 번째 호출 시 추가 호출이 없는지 검증
        mock_query_service.get_running_tasks.reset_mock()

        # 두 번째 호출 (즉시 반환)
        await graceful_shutdown(app, tm)

        # 두 번째 호출에서는 get_running_tasks가 호출되지 않아야 함
        assert mock_query_service.get_running_tasks.call_count == 0
