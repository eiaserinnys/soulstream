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
        # F-C(2026-05-17): ring buffer TTL을 default 300s → 1800s(30분)로 확장.
        # 5분 TTL은 클라이언트가 잠시 자리를 비웠다 돌아왔을 때(백그라운드 탭, 잠금 화면 등)
        # replay_gap을 강제 → catalog REST refetch로 우회되는 회로가 본 회귀의 결정적 원인
        # 후보 (analysis 캐시 20260516-1707-dashboard-feed-realtime-regression §5.1 가설 Z).
        # 메모리 추정: 평균 broadcast ~3/분 × 1800s = ~90건 << maxlen=1000.
        #   평균 이벤트 크기 ~1.5KB → 평균 ~135KB, 폭증 시 maxlen=1000 cap → 최대 ~1.5MB.
        # BaseSessionBroadcaster default(300s)는 변경하지 않는다 — soul-server 측
        # SessionBroadcaster의 connector lifecycle은 별 의도라 본 변경 범위 외.
        super().__init__(use_lock=False, recent_events_ttl_sec=1800.0)

    async def broadcast_session_list_change(self, change: dict) -> None:
        """세션 목록 변경 이벤트를 브로드캐스트한다."""
        await self.broadcast(change)

    async def broadcast_node_change(self, change: dict) -> None:
        """노드 상태 변경 이벤트를 브로드캐스트한다."""
        await self.broadcast(change)

    async def subscribe(self) -> AsyncIterator[tuple[int, dict]]:
        """SSE 클라이언트 구독. 연결 해제 시 자동 정리.

        yield: (event_id, event_dict) 튜플. None sentinel(disconnect_all) 시 break.
        """
        queue = self.add_client()
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                yield item  # (event_id, event_dict)
        finally:
            self.remove_client(queue)

    # broadcast, add_client, remove_client, disconnect_all,
    # emit_session_deleted, emit_read_position_updated는 BaseSessionBroadcaster에서 상속
