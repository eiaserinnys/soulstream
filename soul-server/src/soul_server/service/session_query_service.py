"""SessionQueryService — 세션 목록/폴더 조회 책임 분리.

TaskManager에서 분리된 순수 조회(read) 메서드를 담당한다.
쓰기(mutation)는 TaskManager에 남는다.

_tasks dict 참조 공유 설계 근거:
- get_running_tasks는 전체 dict를 순회하므로 콜백 주입 대비 효율적
- get_all_sessions는 session_id별 _tasks.get() 조회 → 콜백이면 n회 호출
- TaskManager는 _tasks를 __init__에서 한 번 할당 후 교체하지 않음 (put/pop만 수행)
- 정본은 TaskManager._tasks이고 SessionQueryService는 읽기 전용 소비자
"""

import logging
from typing import Dict, List, Optional, Union, TYPE_CHECKING

if TYPE_CHECKING:
    from soul_server.service.agent_registry import AgentRegistry

from soul_server.service.task_models import Task, TaskStatus
from soul_server.service.postgres_session_db import PostgresSessionDB

logger = logging.getLogger(__name__)


def _build_session_dict(
    row: dict,
    task: Optional[Task] = None,
    registry: Optional["AgentRegistry"] = None,
) -> dict:
    """DB 행과 메모리 Task를 API 응답 dict로 변환하는 순수 함수.

    Args:
        row: DB에서 조회한 세션 행 (dict)
        task: 메모리에 있는 Task (running 세션의 pid/event_id 보충용, 없을 수 있음)
        registry: AgentRegistry (에이전트 정보 보충용, 없을 수 있음)

    Returns:
        API 응답용 세션 dict
    """
    session_id = row["session_id"]
    pid = task.pid if task else None
    created_at = row.get("created_at")
    last_event_id = task.last_event_id if task else row.get("last_event_id", 0)
    last_read_event_id = task.last_read_event_id if task else row.get("last_read_event_id", 0)
    updated_at = row.get("updated_at") or created_at

    info: dict = {
        "agent_session_id": session_id,
        "status": row.get("status"),
        "prompt": row.get("prompt"),
        "created_at": created_at.isoformat() if created_at else None,
        "updated_at": updated_at.isoformat() if updated_at else None,
        "pid": pid,
        "session_type": row.get("session_type") or "claude",
        "last_message": row.get("last_message"),
        "metadata": row.get("metadata") or [],
        "last_event_id": last_event_id,
        "last_read_event_id": last_read_event_id,
        "display_name": row.get("display_name"),
        "node_id": row.get("node_id"),
    }

    if row.get("session_type", "claude") != "claude":
        info["llm_provider"] = row.get("llm_provider")
        info["llm_model"] = row.get("llm_model")
        info["llm_usage"] = row.get("llm_usage")
        info["client_id"] = row.get("client_id")

    # agent 정보 보충 (soul-dashboard에서 포트레이트 표시용)
    agent_id = row.get("agent_id")
    if agent_id:
        info["agentId"] = agent_id
        if registry:
            agent = registry.get(agent_id)
            if agent:
                info["agentName"] = agent.name
                info["agentPortraitUrl"] = (
                    f"/api/agents/{agent.id}/portrait" if agent.portrait_path else None
                )

    return info


class SessionQueryService:
    """세션 목록/폴더 조회 전용 서비스.

    TaskManager._tasks dict를 참조 공유하여 런타임 상태를 보충한다.
    """

    def __init__(self, session_db: PostgresSessionDB, tasks: Dict[str, Task]):
        self._db = session_db
        self._tasks = tasks  # TaskManager._tasks 참조 공유 (동일 dict 객체)

    def get_running_tasks(self) -> List[Task]:
        """실행 중인 태스크 목록 반환"""
        return [t for t in self._tasks.values() if t.status == TaskStatus.RUNNING]

    async def get_all_sessions(
        self,
        offset: int = 0,
        limit: int = 0,
        session_type: Optional[str] = None,
        folder_id: Optional[str] = None,
        node_id: Optional[str] = None,
        status: Optional[Union[str, list[str]]] = None,
        feed_only: bool = False,
    ) -> tuple[list[dict], int]:
        """세션 목록 반환 (생성일 기준 내림차순, 페이지네이션 + 타입/폴더/노드/상태 필터 지원)

        카탈로그 기반으로 전체 세션 목록을 반환합니다.
        running 세션의 pid는 _tasks에서 보충합니다.

        Args:
            offset: 건너뛸 항목 수 (기본 0)
            limit: 반환할 최대 항목 수 (0이면 전체)
            session_type: 세션 타입 필터 ("claude" | "llm", None이면 전체)
            folder_id: 폴더 ID 필터 (None이면 전체)
            node_id: 노드 ID 필터 (None이면 전체)
            status: 상태 필터 (str 또는 list[str], None이면 전체)
            feed_only: True이면 excludeFromFeed=true인 폴더의 세션을 제외

        Returns:
            (세션 dict 리스트, 전체 세션 수) 튜플
        """
        sessions, total = await self._db.get_all_sessions(
            offset=offset, limit=limit, session_type=session_type,
            folder_id=folder_id, node_id=node_id, status=status,
            feed_only=feed_only,
        )

        # AgentRegistry는 루프 밖에서 1회만 조회한다.
        try:
            from soul_server.bootstrap import get_agent_registry
            registry = get_agent_registry()
        except Exception:
            registry = None

        result = [
            _build_session_dict(s, self._tasks.get(s["session_id"]), registry)
            for s in sessions
        ]
        return result, total

    async def list_sessions_summary(
        self,
        search: str | None = None,
        session_type: str | None = None,
        limit: int = 20,
        offset: int = 0,
        folder_id: str | None = None,
        node_id: str | None = None,
    ) -> tuple[list[dict], int]:
        """경량 세션 목록을 반환한다 (display_name, status, event_count 등)."""
        return await self._db.list_sessions_summary(
            search=search, session_type=session_type, limit=limit, offset=offset,
            folder_id=folder_id, node_id=node_id,
        )

    async def get_all_folders(self) -> list[dict]:
        """모든 폴더 목록을 반환한다."""
        return await self._db.get_all_folders()


# === 싱글턴 접근자 ===

_session_query_service: Optional[SessionQueryService] = None


def init_session_query_service(session_db: PostgresSessionDB, tasks: Dict[str, Task]) -> SessionQueryService:
    """SessionQueryService 싱글턴 초기화. TaskManager.__init__에서 호출."""
    global _session_query_service
    _session_query_service = SessionQueryService(session_db, tasks)
    return _session_query_service


def get_session_query_service() -> SessionQueryService:
    """SessionQueryService 싱글턴 접근자."""
    if _session_query_service is None:
        raise RuntimeError("SessionQueryService not initialized. Call init_session_query_service() first.")
    return _session_query_service
