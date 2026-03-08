"""
SessionBroadcaster - 세션 목록 변경 이벤트 브로드캐스트

대시보드의 세션 목록 SSE 구독을 위한 컴포넌트입니다.
세션 생성/업데이트/삭제 시 모든 리스너에게 이벤트를 발행합니다.
"""

import asyncio
import logging
from typing import List, Optional
from datetime import datetime

from soul_server.service.task_models import Task, utc_now

logger = logging.getLogger(__name__)


class SessionBroadcaster:
    """세션 목록 변경 이벤트 브로드캐스터

    리스너 등록/해제 및 이벤트 브로드캐스트를 관리합니다.
    """

    def __init__(self):
        self._listeners: List[asyncio.Queue] = []
        self._lock = asyncio.Lock()

    @property
    def listener_count(self) -> int:
        """현재 리스너 수"""
        return len(self._listeners)

    async def add_listener(self, queue: asyncio.Queue) -> None:
        """리스너 추가"""
        async with self._lock:
            self._listeners.append(queue)
            logger.debug(f"Session broadcaster: listener added (total={len(self._listeners)})")

    async def remove_listener(self, queue: asyncio.Queue) -> None:
        """리스너 제거"""
        async with self._lock:
            if queue in self._listeners:
                self._listeners.remove(queue)
                logger.debug(f"Session broadcaster: listener removed (total={len(self._listeners)})")

    async def broadcast(self, event: dict) -> int:
        """모든 리스너에게 이벤트 브로드캐스트

        Args:
            event: 브로드캐스트할 이벤트

        Returns:
            브로드캐스트된 리스너 수
        """
        async with self._lock:
            count = 0
            for queue in self._listeners:
                try:
                    queue.put_nowait(event)
                    count += 1
                except asyncio.QueueFull:
                    logger.warning("Session broadcaster: queue full, skipping")
            return count

    def _task_to_session_info(self, task: Task) -> dict:
        """Task를 세션 정보 dict로 변환"""
        # updated_at은 completed_at 또는 created_at
        updated_at = task.completed_at or task.created_at
        return {
            "agent_session_id": task.agent_session_id,
            "status": task.status.value,
            "prompt": task.prompt,
            "created_at": task.created_at.isoformat(),
            "updated_at": updated_at.isoformat(),
        }

    async def emit_session_created(self, task: Task) -> int:
        """세션 생성 이벤트 발행"""
        event = {
            "type": "session_created",
            "session": self._task_to_session_info(task),
        }
        return await self.broadcast(event)

    async def emit_session_updated(self, task: Task) -> int:
        """세션 업데이트 이벤트 발행"""
        updated_at = task.completed_at or utc_now()
        event = {
            "type": "session_updated",
            "agent_session_id": task.agent_session_id,
            "status": task.status.value,
            "updated_at": updated_at.isoformat(),
        }
        return await self.broadcast(event)

    async def emit_session_deleted(self, agent_session_id: str) -> int:
        """세션 삭제 이벤트 발행"""
        event = {
            "type": "session_deleted",
            "agent_session_id": agent_session_id,
        }
        return await self.broadcast(event)


# 싱글톤 인스턴스
_session_broadcaster: Optional[SessionBroadcaster] = None


def get_session_broadcaster() -> SessionBroadcaster:
    """SessionBroadcaster 싱글톤 반환

    Raises:
        RuntimeError: init_session_broadcaster()가 호출되지 않은 경우
    """
    if _session_broadcaster is None:
        raise RuntimeError(
            "SessionBroadcaster not initialized. "
            "Call init_session_broadcaster() first."
        )
    return _session_broadcaster


def init_session_broadcaster() -> SessionBroadcaster:
    """SessionBroadcaster 초기화"""
    global _session_broadcaster
    _session_broadcaster = SessionBroadcaster()
    return _session_broadcaster


def set_session_broadcaster(broadcaster: Optional[SessionBroadcaster]) -> None:
    """SessionBroadcaster 인스턴스 설정 (테스트용)"""
    global _session_broadcaster
    _session_broadcaster = broadcaster
