"""
BaseSessionBroadcaster — SSE 큐 기반 브로드캐스터 공통 기반 클래스.

soul-server와 soulstream-server 양쪽에서 공유하는
asyncio.Queue 관리 + broadcast 로직을 정의한다.

서비스별 서브클래스는 서비스 고유 emit 메서드만 추가 구현한다.

Phase 1 (Last-Event-ID replay):
- broadcast()마다 monotonic event_id를 부여하고 (event_id, event_dict) 튜플을 큐에 푸시한다.
- recent_events ring buffer(maxlen + TTL)를 유지하여 SSE 재연결 시 누락 이벤트를 replay 가능하게 한다.
- replay_since(last_event_id, client_instance_id) → ReplayResult.
- 서버 재시작은 instance_id 변경으로 표현된다.
"""

import asyncio
import logging
import time
import uuid
from collections import deque
from typing import Any, NamedTuple

logger = logging.getLogger(__name__)


class ReplayResult(NamedTuple):
    """replay_since() 반환값.

    events: (event_id, event_dict) 튜플 리스트 — last_event_id 이후 발생한 이벤트들.
    gap: True이면 last_event_id가 ring buffer 밖(또는 instance_id 불일치) — 클라는 풀 재페치 필요.
    latest_id: 현재 broadcaster의 최신 event_id (gap 시 클라가 이 값으로 점프).
    instance_id: 이 broadcaster 인스턴스의 식별자.

    계약: replay_since() 호출 시점까지 broadcast된 모든 event_id ≤ latest_id를 포함한다.
    SSE 핸들러가 큐 등록 후 replay_since 호출 시, 그 사이 도착한 broadcast는 큐와 replay.events
    양쪽에 포함되며 호출자가 dedup으로 차단한다.
    """

    events: list[tuple[int, dict[str, Any]]]
    gap: bool
    latest_id: int
    instance_id: str


class BaseSessionBroadcaster:
    """공통 큐 기반 브로드캐스터.

    서비스별 서브클래스는 emit 메서드만 추가 구현한다.

    Args:
        use_lock: True이면 broadcast/add_client/remove_client에 asyncio.Lock을 사용.
                  soul-server는 True, soulstream-server는 False(기본값).
        queue_maxsize: add_client() 호출 시 생성되는 큐의 기본 최대 크기.
        recent_events_maxlen: ring buffer 최대 보관 이벤트 수.
        recent_events_ttl_sec: ring buffer 보관 TTL (초). maxlen 또는 TTL 둘 중
                               먼저 도달하는 것으로 oldest drop.
    """

    def __init__(
        self,
        *,
        use_lock: bool = False,
        queue_maxsize: int = 256,
        recent_events_maxlen: int = 1000,
        recent_events_ttl_sec: float = 300.0,
    ) -> None:
        self._clients: list[asyncio.Queue[tuple[int, dict] | None]] = []
        self._lock: asyncio.Lock | None = asyncio.Lock() if use_lock else None
        self._queue_maxsize = queue_maxsize
        self._instance_id: str = uuid.uuid4().hex
        self._event_id_counter: int = 0
        self._recent_events: deque[tuple[int, float, dict[str, Any]]] = deque(
            maxlen=recent_events_maxlen
        )
        self._recent_events_ttl_sec: float = recent_events_ttl_sec

    @property
    def instance_id(self) -> str:
        """이 broadcaster 인스턴스의 식별자. 서버 재시작마다 새로 생성됨."""
        return self._instance_id

    @property
    def latest_event_id(self) -> int:
        """현재까지 발급된 최신 event_id. 0이면 아직 broadcast 없음."""
        return self._event_id_counter

    def add_client(
        self, maxsize: int | None = None
    ) -> asyncio.Queue[tuple[int, dict] | None]:
        """새 클라이언트 큐를 생성하여 등록하고 반환한다.

        큐 항목 형식: (event_id, event_dict) 튜플. None은 disconnect_all 신호.
        """
        queue: asyncio.Queue[tuple[int, dict] | None] = asyncio.Queue(
            maxsize=maxsize if maxsize is not None else self._queue_maxsize
        )
        self._clients.append(queue)
        return queue

    def remove_client(
        self, queue: asyncio.Queue[tuple[int, dict] | None]
    ) -> None:
        """클라이언트 큐를 등록 해제한다."""
        try:
            self._clients.remove(queue)
        except ValueError:
            pass

    async def broadcast(self, event: dict[str, Any]) -> int:
        """모든 클라이언트 큐에 이벤트를 전송한다.

        - monotonic event_id를 부여한다.
        - recent_events ring buffer에 적재한다 (broadcast 경로에서도 TTL evict 호출).
        - 큐에 (event_id, event) 튜플로 푸시한다. QueueFull인 큐는 제거한다.
        - ring 적재는 큐 push 성공 여부와 무관 — dead client는 다음 SSE 재연결 시
          replay_since()로 복구된다.

        Returns:
            실제로 전송된 클라이언트 수.
        """

        async def _do_broadcast() -> int:
            # 1. event_id 부여 (monotonic). 단일 asyncio loop + (use_lock=True인 경우) Lock으로 race 차단.
            self._event_id_counter += 1
            event_id = self._event_id_counter

            # 2. ring buffer 적재 + TTL evict (broadcast 경로에서도 evict하여 "5분 빠른 쪽" 보장)
            now = time.monotonic()
            self._recent_events.append((event_id, now, event))
            self._evict_expired()

            # 3. 모든 클라 큐에 (event_id, event) 푸시. push 실패해도 ring 적재는 유지.
            dead: list[asyncio.Queue] = []
            count = 0
            for q in self._clients:
                try:
                    q.put_nowait((event_id, event))
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

    def replay_since(
        self,
        last_event_id: int | None,
        client_instance_id: str | None,
    ) -> ReplayResult:
        """last_event_id 이후 발생한 이벤트들을 ring buffer에서 추출한다.

        gap=True 케이스:
        - client_instance_id가 본 인스턴스와 다름 (서버 재시작).
        - last_event_id가 ring buffer의 가장 오래된 id - 1보다 작음 (ring 회전으로 유실).
        - ring이 비어있고 last_event_id > latest_id (불가능한 미래 id).
        """
        latest_id = self._event_id_counter

        # 인스턴스 변경 (서버 재시작) — gap
        if client_instance_id is not None and client_instance_id != self._instance_id:
            return ReplayResult(
                events=[],
                gap=True,
                latest_id=latest_id,
                instance_id=self._instance_id,
            )

        # 첫 연결
        if last_event_id is None:
            return ReplayResult(
                events=[],
                gap=False,
                latest_id=latest_id,
                instance_id=self._instance_id,
            )

        self._evict_expired()

        if not self._recent_events:
            if last_event_id <= latest_id:
                return ReplayResult(
                    events=[],
                    gap=False,
                    latest_id=latest_id,
                    instance_id=self._instance_id,
                )
            return ReplayResult(
                events=[],
                gap=True,
                latest_id=latest_id,
                instance_id=self._instance_id,
            )

        oldest_id = self._recent_events[0][0]
        if last_event_id < oldest_id - 1:
            return ReplayResult(
                events=[],
                gap=True,
                latest_id=latest_id,
                instance_id=self._instance_id,
            )

        events = [
            (eid, ev) for eid, _ts, ev in self._recent_events if eid > last_event_id
        ]
        return ReplayResult(
            events=events,
            gap=False,
            latest_id=latest_id,
            instance_id=self._instance_id,
        )

    def _evict_expired(self) -> None:
        """TTL을 초과한 oldest 이벤트들을 popleft로 제거한다."""
        now = time.monotonic()
        cutoff = now - self._recent_events_ttl_sec
        while self._recent_events and self._recent_events[0][1] < cutoff:
            self._recent_events.popleft()

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
