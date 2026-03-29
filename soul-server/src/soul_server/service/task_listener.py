"""
Task Listener - SSE 리스너 관리

세션(agent_session_id) 단위로 SSE 리스너를 관리하고 이벤트를 브로드캐스트합니다.
Task 생명주기(evict/resume)와 독립적으로 동작합니다.
"""

import asyncio
import logging
from typing import Dict, List

logger = logging.getLogger(__name__)


class TaskListenerManager:
    """
    SSE 리스너 관리자

    세션별 리스너 큐를 session_id → list[Queue] 레지스트리로 관리합니다.
    Task 객체와 독립적으로 동작하므로 Task가 evict/resume되어도 기존 큐가 유지됩니다.
    """

    def __init__(self):
        self._listeners: Dict[str, List[asyncio.Queue]] = {}

    async def add_listener(self, agent_session_id: str, queue: asyncio.Queue) -> None:
        """
        SSE 리스너 추가. Task 유무와 무관하게 항상 성공합니다.

        Args:
            agent_session_id: 세션 식별자
            queue: 이벤트를 받을 큐
        """
        self._listeners.setdefault(agent_session_id, []).append(queue)
        count = len(self._listeners[agent_session_id])
        logger.info(f"[LISTENER] Added listener to session {agent_session_id}, total: {count}")

    async def remove_listener(self, agent_session_id: str, queue: asyncio.Queue) -> None:
        """
        SSE 리스너 제거. Task 존재 여부와 무관하게 _listeners 레지스트리에서 직접 제거합니다.
        세션이 없거나 큐가 목록에 없으면 조용히 무시합니다.

        Args:
            agent_session_id: 세션 식별자
            queue: 제거할 큐
        """
        listeners = self._listeners.get(agent_session_id, [])
        if queue in listeners:
            listeners.remove(queue)
            logger.info(f"[LISTENER] Removed listener from session {agent_session_id}, remaining: {len(listeners)}")

    async def broadcast(self, agent_session_id: str, event: dict) -> int:
        """
        모든 리스너에게 이벤트 브로드캐스트. 큐가 가득 찬 dead listener는 자동 제거합니다.

        Args:
            agent_session_id: 세션 식별자
            event: 브로드캐스트할 이벤트

        Returns:
            전송된 리스너 수
        """
        dead_listeners = []
        count = 0
        for queue in self._listeners.get(agent_session_id, []):
            try:
                queue.put_nowait(event)
                count += 1
            except asyncio.QueueFull:
                logger.warning(f"[LISTENER] Queue full, removing dead listener from {agent_session_id}")
                dead_listeners.append(queue)
            except Exception as e:
                logger.warning(f"Failed to broadcast to listener: {e}")

        for dead in dead_listeners:
            self._listeners[agent_session_id].remove(dead)

        if count > 0:
            event_type = event.get("type", "unknown")
            logger.info(f"[BROADCAST] {agent_session_id} -> {count} listener(s), event={event_type}")

        return count
