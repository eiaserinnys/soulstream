"""
SessionBroadcaster — SSE를 통한 세션/노드 변경 브로드캐스트.

SessionBroadcasterProtocol(soul-common) 구현체.
"""

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from typing import Any

logger = logging.getLogger(__name__)


class SessionBroadcaster:
    """SSE 클라이언트들에게 세션 목록 변경을 브로드캐스트한다.

    soul_common.catalog.catalog_service.SessionBroadcasterProtocol을 구현.
    """

    def __init__(self) -> None:
        self._clients: list[asyncio.Queue[dict | None]] = []

    async def broadcast(self, event: dict) -> None:
        """모든 SSE 클라이언트에게 이벤트를 전송한다."""
        dead: list[asyncio.Queue] = []
        for q in self._clients:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                logger.warning("SSE client queue full, disconnecting")
                dead.append(q)
        for q in dead:
            try:
                self._clients.remove(q)
            except ValueError:
                pass

    async def emit_session_deleted(self, agent_session_id: str) -> None:
        """세션 삭제 이벤트를 브로드캐스트한다."""
        await self.broadcast({
            "type": "session_deleted",
            "agent_session_id": agent_session_id,
        })

    async def broadcast_session_list_change(self, change: dict) -> None:
        """세션 목록 변경 이벤트를 브로드캐스트한다."""
        await self.broadcast(change)

    async def broadcast_node_change(self, change: dict) -> None:
        """노드 상태 변경 이벤트를 브로드캐스트한다."""
        await self.broadcast(change)

    def add_client(self, maxsize: int = 256) -> asyncio.Queue[dict | None]:
        """새 클라이언트 큐를 등록하고 반환한다."""
        queue: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=maxsize)
        self._clients.append(queue)
        return queue

    def remove_client(self, queue: asyncio.Queue[dict | None]) -> None:
        """클라이언트 큐를 등록 해제한다."""
        try:
            self._clients.remove(queue)
        except ValueError:
            pass

    async def subscribe(self) -> AsyncIterator[dict]:
        """SSE 클라이언트 구독. 연결 해제 시 자동 정리."""
        queue = self.add_client()
        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield event
        finally:
            self.remove_client(queue)

    def disconnect_all(self) -> None:
        """모든 SSE 클라이언트 연결을 종료한다."""
        for q in self._clients:
            q.put_nowait(None)
        self._clients.clear()
