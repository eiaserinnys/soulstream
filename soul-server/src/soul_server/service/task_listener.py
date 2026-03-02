"""
Task Listener - SSE 리스너 관리

세션(agent_session_id) 단위로 SSE 리스너를 관리하고 이벤트를 브로드캐스트합니다.
"""

import asyncio
import logging
from typing import Dict

from soul_server.service.task_models import Task

logger = logging.getLogger(__name__)


class TaskListenerManager:
    """
    SSE 리스너 관리자

    세션별 리스너 큐를 관리하고 이벤트를 브로드캐스트합니다.
    """

    def __init__(self, tasks: Dict[str, Task]):
        """
        Args:
            tasks: TaskManager의 태스크 딕셔너리 참조 (key = agent_session_id)
        """
        self._tasks = tasks

    async def add_listener(self, agent_session_id: str, queue: asyncio.Queue) -> bool:
        """
        SSE 리스너 추가

        Args:
            agent_session_id: 세션 식별자
            queue: 이벤트를 받을 큐

        Returns:
            성공 여부 (세션 존재 여부)
        """
        task = self._tasks.get(agent_session_id)
        if not task:
            return False

        task.listeners.append(queue)
        logger.info(f"[LISTENER] Added listener to session {agent_session_id}, total: {len(task.listeners)}")
        return True

    async def remove_listener(self, agent_session_id: str, queue: asyncio.Queue) -> None:
        """
        SSE 리스너 제거

        Args:
            agent_session_id: 세션 식별자
            queue: 제거할 큐
        """
        task = self._tasks.get(agent_session_id)
        if task and queue in task.listeners:
            task.listeners.remove(queue)
            logger.info(f"[LISTENER] Removed listener from session {agent_session_id}, remaining: {len(task.listeners)}")

    async def broadcast(self, agent_session_id: str, event: dict) -> int:
        """
        모든 리스너에게 이벤트 브로드캐스트

        Args:
            agent_session_id: 세션 식별자
            event: 브로드캐스트할 이벤트

        Returns:
            전송된 리스너 수
        """
        task = self._tasks.get(agent_session_id)
        if not task:
            return 0

        count = 0
        for queue in task.listeners:
            try:
                await queue.put(event)
                count += 1
            except Exception as e:
                logger.warning(f"Failed to broadcast to listener: {e}")

        if count > 0:
            event_type = event.get("type", "unknown")
            logger.info(f"[BROADCAST] {agent_session_id} -> {count} listener(s), event={event_type}")

        return count
