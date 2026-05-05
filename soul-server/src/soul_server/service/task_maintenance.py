"""
TaskMaintenance — 세션 라이프사이클 유지보수 (취소·고아 보정·통계).

TaskManager에서 추출됨. _tasks/_lock/eviction_manager/executor/db의 정본
소유자는 TaskManager에 남고, maintenance는 참조를 주입받아 사용한다
(task_executor.py / task_factory.py와 동일한 의존성 주입 패턴).
"""

import asyncio
import logging
from datetime import timedelta
from typing import Dict

from soul_server.service.task_models import (
    Task,
    TaskStatus,
    utc_now,
    datetime_to_str,
)
from soul_server.service.postgres_session_db import PostgresSessionDB
from soul_server.service.session_broadcaster import get_session_broadcaster
from soul_server.service.session_eviction_manager import SessionEvictionManager
from soul_server.service.task_executor import TaskExecutor

logger = logging.getLogger(__name__)


class TaskMaintenance:
    """실행 취소 + 고아 보정 + 통계 — TaskManager 보조."""

    def __init__(
        self,
        *,
        tasks: Dict[str, Task],
        lock: asyncio.Lock,
        eviction_manager: SessionEvictionManager,
        executor: TaskExecutor,
        session_db: PostgresSessionDB,
    ):
        self._tasks = tasks
        self._lock = lock
        self._eviction_manager = eviction_manager
        self._executor = executor
        self._db = session_db

    async def cancel_running_tasks(self, timeout: float = 5.0) -> int:
        """실행 중인 모든 태스크 취소.

        퇴거 루프를 정지하고 lock을 잡은 뒤 executor에 위임한다.
        원본: task_manager.py L737-743과 동일 동작.
        """
        # 퇴거 루프 중지
        self._eviction_manager.stop()

        async with self._lock:
            return await self._executor.cancel_running_tasks(timeout)

    async def cleanup_orphaned_running(self, max_age_hours: int = 24) -> int:
        """
        고아 running 태스크 보정.

        실행 태스크(execution_task)가 없는데 running 상태인 오래된 세션을
        interrupted로 마킹한다. 완료/에러/중단된 세션은 삭제하지 않고
        메모리에 유지한다 (대시보드 히스토리 조회용).

        원본: task_manager.py L745-793과 동일 동작.
        """
        cutoff = utc_now() - timedelta(hours=max_age_hours)
        fixed = 0
        fixed_tasks = []

        async with self._lock:
            for key, task in self._tasks.items():
                if task.status != TaskStatus.RUNNING:
                    continue
                if task.execution_task is None or task.execution_task.done():
                    if task.created_at < cutoff:
                        task.status = TaskStatus.INTERRUPTED
                        task.error = "실행 태스크 없이 오래된 running 상태 (orphaned)"
                        task.completed_at = utc_now()
                        logger.warning(f"Marked orphaned running session as interrupted: {key}")
                        fixed_tasks.append(task)
                        fixed += 1

        if fixed > 0:
            logger.info(f"Fixed {fixed} orphaned running sessions")
            # DB 업데이트 + 퇴거 후보 등록 (lock 외부 — 원본 그대로)
            for task in fixed_tasks:
                await self._db.update_session(
                    task.agent_session_id,
                    status=TaskStatus.INTERRUPTED.value,
                    updated_at=datetime_to_str(task.completed_at),
                )
                self._eviction_manager.register(task.agent_session_id)
            try:
                broadcaster = get_session_broadcaster()
                for task in fixed_tasks:
                    await broadcaster.emit_session_updated(task)
            except Exception:
                logger.warning("Failed to broadcast orphaned session fixes", exc_info=True)

        return fixed

    async def get_stats(self) -> dict:
        """통계 반환 (메모리 + DB).

        원본: task_manager.py L795-811과 동일 동작.
        """
        running = sum(1 for t in self._tasks.values() if t.status == TaskStatus.RUNNING)
        completed = sum(1 for t in self._tasks.values() if t.status == TaskStatus.COMPLETED)
        error = sum(1 for t in self._tasks.values() if t.status == TaskStatus.ERROR)
        interrupted = sum(1 for t in self._tasks.values() if t.status == TaskStatus.INTERRUPTED)

        _, total_in_db = await self._db.get_all_sessions()
        return {
            "total_in_memory": len(self._tasks),
            "total_in_db": total_in_db,
            "running": running,
            "completed": completed,
            "error": error,
            "interrupted": interrupted,
            "eviction_candidates": self._eviction_manager.candidate_count,
        }
