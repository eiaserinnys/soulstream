"""
test_auth_session - 인증 세션 관리 단위 테스트
"""

import asyncio
from unittest.mock import MagicMock, AsyncMock

import pytest

from soul_server.api.claude_auth.session import (
    AuthSession,
    AuthSessionManager,
    SessionStatus,
)


class TestAuthSession:
    """AuthSession 테스트"""

    def test_is_active_starting(self):
        """STARTING 상태는 활성"""
        session = AuthSession(id="test", status=SessionStatus.STARTING)
        assert session.is_active() is True

    def test_is_active_waiting_code(self):
        """WAITING_CODE 상태는 활성"""
        session = AuthSession(id="test", status=SessionStatus.WAITING_CODE)
        assert session.is_active() is True

    def test_is_active_submitting(self):
        """SUBMITTING 상태는 활성"""
        session = AuthSession(id="test", status=SessionStatus.SUBMITTING)
        assert session.is_active() is True

    def test_is_active_completed(self):
        """COMPLETED 상태는 비활성"""
        session = AuthSession(id="test", status=SessionStatus.COMPLETED)
        assert session.is_active() is False

    def test_is_active_failed(self):
        """FAILED 상태는 비활성"""
        session = AuthSession(id="test", status=SessionStatus.FAILED)
        assert session.is_active() is False

    def test_is_active_cancelled(self):
        """CANCELLED 상태는 비활성"""
        session = AuthSession(id="test", status=SessionStatus.CANCELLED)
        assert session.is_active() is False


class TestAuthSessionManager:
    """AuthSessionManager 테스트"""

    @pytest.fixture
    def manager(self):
        """짧은 타임아웃의 매니저"""
        return AuthSessionManager(timeout_seconds=1)

    @pytest.mark.asyncio
    async def test_create_session(self, manager: AuthSessionManager):
        """세션 생성"""
        session = await manager.create_session()

        assert session is not None
        assert session.status == SessionStatus.STARTING
        assert manager.current_session == session

    @pytest.mark.asyncio
    async def test_create_cancels_existing(self, manager: AuthSessionManager):
        """새 세션 생성 시 기존 세션 취소"""
        session1 = await manager.create_session()
        session2 = await manager.create_session()

        assert session1.status == SessionStatus.CANCELLED
        assert session2.status == SessionStatus.STARTING
        assert manager.current_session == session2

    @pytest.mark.asyncio
    async def test_get_session(self, manager: AuthSessionManager):
        """세션 조회"""
        session = await manager.create_session()

        found = manager.get_session(session.id)
        assert found == session

        not_found = manager.get_session("nonexistent")
        assert not_found is None

    @pytest.mark.asyncio
    async def test_cancel_session(self, manager: AuthSessionManager):
        """세션 취소"""
        session = await manager.create_session()

        cancelled = await manager.cancel_session(session.id)

        assert cancelled is True
        assert session.status == SessionStatus.CANCELLED

    @pytest.mark.asyncio
    async def test_cancel_nonexistent(self, manager: AuthSessionManager):
        """존재하지 않는 세션 취소"""
        cancelled = await manager.cancel_session("nonexistent")
        assert cancelled is False

    @pytest.mark.asyncio
    async def test_cancel_inactive_session(self, manager: AuthSessionManager):
        """비활성 세션 취소 시도"""
        session = await manager.create_session()
        manager.update_status(session, SessionStatus.COMPLETED)

        cancelled = await manager.cancel_session(session.id)
        assert cancelled is False

    @pytest.mark.asyncio
    async def test_cancel_terminates_process(self, manager: AuthSessionManager):
        """취소 시 프로세스 종료"""
        session = await manager.create_session()

        mock_process = MagicMock()
        mock_process.terminate = MagicMock()
        mock_process.wait = AsyncMock()
        manager.set_process(session, mock_process)

        await manager.cancel_session(session.id)

        mock_process.terminate.assert_called_once()

    @pytest.mark.asyncio
    async def test_update_status(self, manager: AuthSessionManager):
        """상태 업데이트"""
        session = await manager.create_session()

        manager.update_status(
            session,
            status=SessionStatus.WAITING_CODE,
            auth_url="https://example.com/oauth",
        )

        assert session.status == SessionStatus.WAITING_CODE
        assert session.auth_url == "https://example.com/oauth"

    @pytest.mark.asyncio
    async def test_timeout(self, manager: AuthSessionManager):
        """타임아웃 후 세션 상태 변경"""
        session = await manager.create_session()

        # 타임아웃 대기 (1초 + 여유)
        await asyncio.sleep(1.5)

        assert session.status == SessionStatus.TIMEOUT

    @pytest.mark.asyncio
    async def test_cleanup(self, manager: AuthSessionManager):
        """매니저 정리"""
        session = await manager.create_session()

        await manager.cleanup()

        assert session.status == SessionStatus.CANCELLED
