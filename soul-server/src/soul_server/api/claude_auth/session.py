"""
인증 세션 관리

AuthSession: 단일 인증 세션 상태
AuthSessionManager: 세션 생성/조회/취소 및 타임아웃 관리
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from asyncio.subprocess import Process

logger = logging.getLogger(__name__)


class SessionStatus(str, Enum):
    """인증 세션 상태"""

    STARTING = "starting"  # subprocess 시작 중
    WAITING_CODE = "waiting_code"  # URL 추출 완료, 코드 입력 대기
    SUBMITTING = "submitting"  # 코드 제출 중
    COMPLETED = "completed"  # 토큰 추출 완료
    FAILED = "failed"  # 실패
    CANCELLED = "cancelled"  # 취소됨
    TIMEOUT = "timeout"  # 타임아웃


@dataclass
class AuthSession:
    """단일 인증 세션"""

    id: str
    status: SessionStatus
    auth_url: str | None = None
    error: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    _process: "Process | None" = field(default=None, repr=False)

    def is_active(self) -> bool:
        """세션이 아직 활성 상태인지 확인"""
        return self.status in (SessionStatus.STARTING, SessionStatus.WAITING_CODE, SessionStatus.SUBMITTING)


class AuthSessionManager:
    """
    인증 세션 관리자

    - 단일 세션만 허용 (새 요청 시 기존 세션 자동 취소)
    - 5분 타임아웃 후 자동 정리
    """

    DEFAULT_TIMEOUT = 300  # 5분

    def __init__(self, timeout_seconds: int = DEFAULT_TIMEOUT):
        self._session: AuthSession | None = None
        self._timeout_seconds = timeout_seconds
        self._timeout_task: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    @property
    def current_session(self) -> AuthSession | None:
        """현재 세션 반환"""
        return self._session

    async def create_session(self) -> AuthSession:
        """
        새 세션 생성

        기존 활성 세션이 있으면 자동 취소합니다.
        """
        async with self._lock:
            # 기존 세션 취소
            if self._session is not None and self._session.is_active():
                await self._cancel_session_internal(self._session)

            # 새 세션 생성
            session_id = str(uuid.uuid4())
            session = AuthSession(
                id=session_id,
                status=SessionStatus.STARTING,
            )
            self._session = session

            # 타임아웃 태스크 시작
            self._start_timeout()

            logger.info(f"Created auth session: {session_id}")
            return session

    def get_session(self, session_id: str) -> AuthSession | None:
        """세션 ID로 세션 조회"""
        if self._session is not None and self._session.id == session_id:
            return self._session
        return None

    async def cancel_session(self, session_id: str) -> bool:
        """세션 취소"""
        async with self._lock:
            if self._session is None or self._session.id != session_id:
                return False

            if not self._session.is_active():
                return False

            await self._cancel_session_internal(self._session)
            return True

    async def _cancel_session_internal(self, session: AuthSession) -> None:
        """내부용 세션 취소 (lock 없이)"""
        session.status = SessionStatus.CANCELLED

        # subprocess 종료
        if session._process is not None:
            try:
                session._process.terminate()
                await asyncio.wait_for(session._process.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                session._process.kill()
            except ProcessLookupError:
                pass  # 이미 종료됨
            except Exception as e:
                logger.warning(f"Error terminating process: {e}")

        self._cancel_timeout()
        logger.info(f"Cancelled auth session: {session.id}")

    def set_process(self, session: AuthSession, process: "Process") -> None:
        """세션에 subprocess 연결"""
        session._process = process

    def update_status(
        self,
        session: AuthSession,
        status: SessionStatus,
        auth_url: str | None = None,
        error: str | None = None,
    ) -> None:
        """세션 상태 업데이트"""
        session.status = status
        if auth_url is not None:
            session.auth_url = auth_url
        if error is not None:
            session.error = error

        # 완료/실패/취소 시 타임아웃 취소
        if not session.is_active():
            self._cancel_timeout()

    def _start_timeout(self) -> None:
        """타임아웃 태스크 시작"""
        self._cancel_timeout()
        self._timeout_task = asyncio.create_task(self._timeout_handler())

    def _cancel_timeout(self) -> None:
        """타임아웃 태스크 취소"""
        if self._timeout_task is not None:
            self._timeout_task.cancel()
            self._timeout_task = None

    async def _timeout_handler(self) -> None:
        """타임아웃 처리"""
        try:
            await asyncio.sleep(self._timeout_seconds)

            async with self._lock:
                if self._session is not None and self._session.is_active():
                    logger.warning(f"Auth session timeout: {self._session.id}")
                    self._session.status = SessionStatus.TIMEOUT

                    # subprocess 종료
                    if self._session._process is not None:
                        try:
                            self._session._process.terminate()
                            await asyncio.wait_for(self._session._process.wait(), timeout=2.0)
                        except Exception:
                            try:
                                self._session._process.kill()
                            except Exception:
                                pass
        except asyncio.CancelledError:
            pass

    async def cleanup(self) -> None:
        """매니저 종료 시 정리"""
        self._cancel_timeout()
        if self._session is not None and self._session.is_active():
            await self._cancel_session_internal(self._session)
