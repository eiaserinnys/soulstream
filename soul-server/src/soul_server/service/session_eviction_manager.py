"""
SessionEvictionManager - LRU 기반 세션 메모리 퇴거 관리자

TaskManager._tasks에서 TTL 만료 세션을 제거한다.
TaskManager는 finalize_task() 완료 시 register()를 호출하고,
퇴거 루프가 TTL 만료 시 _tasks에서 직접 제거한다.

설계 원칙 (지식 경계):
- 이 모듈은 TaskManager를 알지 않는다.
- 퇴거 대상은 생성 시 주입받은 _tasks 딕셔너리 참조로만 접근한다.
- DB 로드는 on-demand 호출 시 파라미터로 전달된다.
"""

import asyncio
import logging
import time
from typing import TYPE_CHECKING, Dict, Optional

if TYPE_CHECKING:
    from soul_server.service.postgres_session_db import PostgresSessionDB
    from soul_server.service.task_models import Task

logger = logging.getLogger(__name__)


class SessionEvictionManager:
    """LRU 기반 세션 메모리 퇴거 관리자."""

    def __init__(self, tasks: dict, eviction_ttl: float) -> None:
        """
        Args:
            tasks: TaskManager._tasks 참조 (퇴거 시 직접 삭제)
            eviction_ttl: 완료 후 메모리 보존 시간 (초)
        """
        self._tasks = tasks
        self._eviction_ttl = eviction_ttl
        self._eviction_candidates: Dict[str, float] = {}
        self._eviction_task: Optional[asyncio.Task] = None

    def start(self) -> None:
        """퇴거 루프 시작 (asyncio 이벤트 루프 안에서 호출)"""
        self._eviction_task = asyncio.create_task(self._eviction_loop())

    def stop(self) -> None:
        """퇴거 루프 중단"""
        if self._eviction_task:
            self._eviction_task.cancel()

    def register(self, session_id: str) -> None:
        """세션을 퇴거 후보로 등록 또는 TTL 갱신"""
        self._eviction_candidates[session_id] = time.time() + self._eviction_ttl

    def unregister(self, session_id: str) -> None:
        """세션을 퇴거 후보에서 제거 (resume 등으로 재활성화될 때 사용)"""
        self._eviction_candidates.pop(session_id, None)

    @property
    def candidate_count(self) -> int:
        """현재 퇴거 후보 세션 수"""
        return len(self._eviction_candidates)

    def is_candidate(self, session_id: str) -> bool:
        """세션이 퇴거 후보 목록에 있는지 확인"""
        return session_id in self._eviction_candidates

    async def _eviction_loop(self) -> None:
        """주기적 퇴거 루프 (60초 간격)"""
        while True:
            try:
                await asyncio.sleep(60)
                evicted = self._run_eviction_check()
                if evicted > 0:
                    logger.info(f"Eviction loop: removed {evicted} sessions from memory")
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("Eviction loop error")

    def _run_eviction_check(self) -> int:
        """퇴거 후보 검사 — TTL 만료된 세션을 _tasks에서 제거

        race condition 방지: resume으로 RUNNING 상태가 된 세션은
        퇴거 후보에서 제거만 하고 _tasks에서 삭제하지 않습니다.

        Returns:
            퇴거된 세션 수
        """
        from soul_server.service.task_models import TaskStatus

        now = time.time()
        evicted = 0
        for session_id in list(self._eviction_candidates):
            if now >= self._eviction_candidates[session_id]:
                task = self._tasks.get(session_id)
                # running 세션은 퇴거하지 않음 (resume으로 재활성화된 경우)
                if task and task.status == TaskStatus.RUNNING:
                    del self._eviction_candidates[session_id]
                    continue
                if session_id in self._tasks:
                    del self._tasks[session_id]
                    logger.debug(f"Evicted session from memory: {session_id}")
                del self._eviction_candidates[session_id]
                evicted += 1
        return evicted

    async def load_evicted_task(
        self,
        session_db: "PostgresSessionDB",
        agent_session_id: str,
    ) -> "Optional[Task]":
        """퇴거된 세션을 DB에서 온디맨드 로드 (메모리에 상주시키지 않음)

        Args:
            session_db: PostgresSessionDB 인스턴스
            agent_session_id: 세션 식별자

        Returns:
            복원된 Task 또는 None
        """
        from soul_server.service.task_models import Task, TaskStatus, str_to_datetime

        entry = await session_db.get_session(agent_session_id)
        if not entry:
            return None

        # 필수 필드 누락 시 안전하게 처리
        status_str = entry.get("status")
        created_at_str = entry.get("created_at")
        if not status_str or not created_at_str:
            logger.warning(
                f"Incomplete catalog entry for {agent_session_id}: "
                f"status={status_str}, created_at={created_at_str}"
            )
            return None

        try:
            # SessionDB에서는 completed_at 대신 updated_at을 사용
            completed_at = None
            if status_str in (
                TaskStatus.COMPLETED.value,
                TaskStatus.ERROR.value,
                TaskStatus.INTERRUPTED.value,
            ):
                updated_at_str = entry.get("updated_at")
                if updated_at_str:
                    completed_at = str_to_datetime(updated_at_str)

            return Task(
                agent_session_id=agent_session_id,
                prompt=entry.get("prompt", ""),
                status=TaskStatus(status_str),
                client_id=entry.get("client_id"),
                claude_session_id=entry.get("claude_session_id"),
                session_type=entry.get("session_type", "claude"),
                last_event_id=entry.get("last_event_id", 0),
                last_read_event_id=entry.get("last_read_event_id", 0),
                created_at=str_to_datetime(created_at_str),
                completed_at=completed_at,
                node_id=entry.get("node_id"),
            )
        except (ValueError, KeyError) as e:
            logger.error(f"Failed to restore task from DB: {agent_session_id}: {e}")
            return None
