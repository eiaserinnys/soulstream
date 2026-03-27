"""
BaseSessionBroadcaster — SSE 큐 기반 브로드캐스터 공통 기반 클래스.

soul-server와 soulstream-server 양쪽에서 공유하는
asyncio.Queue 관리 + broadcast 로직을 정의한다.

서비스별 서브클래스는 서비스 고유 emit 메서드만 추가 구현한다.
"""

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)


class BaseSessionBroadcaster:
    """공통 큐 기반 브로드캐스터.

    서비스별 서브클래스는 emit 메서드만 추가 구현한다.

    Args:
        use_lock: True이면 broadcast/add_client/remove_client에 asyncio.Lock을 사용.
                  soul-server는 True, soulstream-server는 False(기본값).
        queue_maxsize: add_client() 호출 시 생성되는 큐의 기본 최대 크기.
    """

    def __init__(self, *, use_lock: bool = False, queue_maxsize: int = 256) -> None:
        self._clients: list[asyncio.Queue[dict | None]] = []
        self._lock: asyncio.Lock | None = asyncio.Lock() if use_lock else None
        self._queue_maxsize = queue_maxsize

    def add_client(self, maxsize: int | None = None) -> asyncio.Queue[dict | None]:
        """새 클라이언트 큐를 생성하여 등록하고 반환한다."""
        queue: asyncio.Queue[dict | None] = asyncio.Queue(
            maxsize=maxsize if maxsize is not None else self._queue_maxsize
        )
        self._clients.append(queue)
        return queue

    def remove_client(self, queue: asyncio.Queue[dict | None]) -> None:
        """클라이언트 큐를 등록 해제한다."""
        try:
            self._clients.remove(queue)
        except ValueError:
            pass

    async def broadcast(self, event: dict[str, Any]) -> int:
        """모든 클라이언트 큐에 이벤트를 전송한다.

        QueueFull인 큐는 제거한다.

        Returns:
            실제로 전송된 클라이언트 수.
        """
        async def _do_broadcast() -> int:
            dead: list[asyncio.Queue] = []
            count = 0
            for q in self._clients:
                try:
                    q.put_nowait(event)
                    count += 1
                except asyncio.QueueFull:
                    logger.warning("SSE client queue full, disconnecting")
                    dead.append(q)
            for q in dead:
                try:
                    self._clients.remove(q)
                except ValueError:
                    pass
            return count

        if self._lock:
            async with self._lock:
                return await _do_broadcast()
        return await _do_broadcast()

    async def emit_session_deleted(self, agent_session_id: str) -> int:
        """세션 삭제 이벤트를 브로드캐스트한다."""
        return await self.broadcast({
            "type": "session_deleted",
            "agent_session_id": agent_session_id,
        })

    async def emit_read_position_updated(
        self,
        session_id: str,
        last_event_id: int | None,
        last_read_event_id: int | None,
    ) -> int:
        """읽음 위치 변경을 브로드캐스트한다."""
        return await self.broadcast({
            "type": "session_updated",
            "agent_session_id": session_id,
            "last_event_id": last_event_id,
            "last_read_event_id": last_read_event_id,
        })

    @property
    def client_count(self) -> int:
        """현재 연결된 클라이언트 수."""
        return len(self._clients)

    def disconnect_all(self) -> None:
        """모든 클라이언트 연결을 종료한다. None을 전송하여 구독자 루프를 종료시킨다."""
        for q in self._clients:
            try:
                q.put_nowait(None)
            except asyncio.QueueFull:
                pass
        self._clients.clear()
