"""
SessionBroadcaster — SSE를 통한 세션/노드 변경 브로드캐스트.

BaseSessionBroadcaster(soul-common)를 상속하여 큐 관리 로직을 재사용하며,
soulstream-server 고유의 emit 메서드만 추가 구현합니다.

SessionBroadcasterProtocol(soul-common) 구현체.
"""

import asyncio
import logging
from collections.abc import AsyncIterator

from soul_common.broadcaster import BaseSessionBroadcaster

logger = logging.getLogger(__name__)


class SessionBroadcaster(BaseSessionBroadcaster):
    """SSE 클라이언트들에게 세션 목록 변경을 브로드캐스트한다.

    soul_common.catalog.catalog_service.SessionBroadcasterProtocol을 구현.
    use_lock=False(기본값)로 생성된다.
    """

    def __init__(self) -> None:
        super().__init__(use_lock=False)

    async def broadcast_session_list_change(self, change: dict) -> None:
        """세션 목록 변경 이벤트를 브로드캐스트한다."""
        await self.broadcast(change)

    async def broadcast_node_change(self, change: dict) -> None:
        """노드 상태 변경 이벤트를 브로드캐스트한다."""
        await self.broadcast(change)

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

    # broadcast, add_client, remove_client, disconnect_all,
    # emit_session_deleted, emit_read_position_updated는 BaseSessionBroadcaster에서 상속
