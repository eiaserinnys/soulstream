"""SessionQueryService — 세션 목록/폴더 조회 책임 분리.

TaskManager에서 분리된 순수 조회(read) 메서드를 담당한다.
쓰기(mutation)는 TaskManager에 남는다.

_tasks dict 참조 공유 설계 근거:
- get_running_tasks는 전체 dict를 순회하므로 콜백 주입 대비 효율적
- get_all_sessions는 session_id별 _tasks.get() 조회 → 콜백이면 n회 호출
- TaskManager는 _tasks를 __init__에서 한 번 할당 후 교체하지 않음 (put/pop만 수행)
- 정본은 TaskManager._tasks이고 SessionQueryService는 읽기 전용 소비자
"""

import asyncio
import json
import logging
from typing import AsyncGenerator, Dict, List, Optional, Union, TYPE_CHECKING

if TYPE_CHECKING:
    from soul_server.service.agent_registry import AgentRegistry

from soul_common.auth import extract_caller_info_from_metadata
from soul_server.service.task_models import Task, TaskStatus
from soul_server.service.postgres_session_db import PostgresSessionDB

logger = logging.getLogger(__name__)


class InvalidViewportRangeError(ValueError):
    """y_min > y_max 검증 실패. 라우터가 HTTP 400으로 변환한다.

    검증 책임을 service에 응집하여 두 라우터(api/sessions.py,
    dashboard/routes/sessions.py)의 viewport 핸들러가 동일한 도메인 예외만
    HTTPException으로 변환하면 되도록 한다.
    """

    def __init__(self, y_min: int, y_max: int):
        self.y_min = y_min
        self.y_max = y_max
        super().__init__(f"y_min ({y_min}) must be <= y_max ({y_max})")


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
        # 사용자 프로필 키는 항상 존재(None 가능) — wire 일관성. orch _session_to_response와 대칭.
        # caller_info 추출(아래) 또는 dashboard 라우트의 헬퍼가 채운다.
        "userName": None,
        "userPortraitUrl": None,
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

    # 사용자 정보: caller_info(atom ed3a216d) 우선 추출. 부재 시 dashboard 라우트가
    # settings.dash_user_name으로 fallback (apply_dash_user_profile_enrichment).
    # R-3 fix(2026-05-08): orch _session_to_response와 동일 추출 패턴 — 정본 둘
    # 안티패턴 회피를 위해 caller_info → userName/userPortraitUrl 매핑은 어디서든 동일.
    caller_info = extract_caller_info_from_metadata(row.get("metadata"))
    if caller_info:
        display_name = caller_info.get("display_name")
        avatar_url = caller_info.get("avatar_url")
        # R-2 fix(2026-05-10): caller_info.source를 entry에 promote — _query.py가
        # apply_dash_user_profile_enrichment(caller_source=...)로 전달하여 정체성
        # 명시 source(agent/system 등)가 settings.dash_user_*로 덮이지 않게 한다.
        # 키 이름은 orch SSE wire의 top-level caller_source와 동일 (atom b558ca3b §3 정본 하나).
        source = caller_info.get("source")
        if isinstance(display_name, str) and display_name:
            info["userName"] = display_name
        if isinstance(avatar_url, str) and avatar_url:
            info["userPortraitUrl"] = avatar_url
        if isinstance(source, str) and source:
            info["caller_source"] = source

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

    # === viewport / messages / stream — 미러링 핸들러 dedupe (260505.15) ===

    async def read_viewport(self, session_id: str, y_min: int, y_max: int) -> dict:
        """뷰포트 영역과 겹치는 이벤트 + 세션 전체 높이.

        api/sessions.py의 GET /sessions/{id}/events/viewport와
        dashboard/routes/sessions.py의 동명 핸들러가 호출하는 정본.

        Returns:
            {"events": [...], "total_subtree_height": int}

        Raises:
            InvalidViewportRangeError: y_min > y_max.
        """
        if y_min > y_max:
            raise InvalidViewportRangeError(y_min, y_max)
        events = await self._db.read_viewport(session_id, y_min, y_max)
        total = await self._db.read_total_subtree_height(session_id)
        return {"events": events, "total_subtree_height": total}

    async def read_messages(
        self,
        session_id: str,
        before: Optional[str] = None,
        limit: int = 50,
    ) -> dict:
        """메시지 페이지네이션 조회.

        api/sessions.py의 GET /sessions/{id}/messages와
        dashboard/routes/sessions.py의 동명 핸들러가 호출하는 정본.

        Returns:
            {"messages": [...], "next_cursor": str | None}
        """
        messages, next_cursor = await self._db.read_messages(
            session_id, before=before, limit=limit,
        )
        return {"messages": messages, "next_cursor": next_cursor}

    async def stream_session_list_events(
        self,
        *,
        limit: int = 0,
    ) -> AsyncGenerator[dict, None]:
        """세션 목록 변경 SSE generator.

        api/sessions.py의 GET /sessions/stream과 dashboard/routes/sessions.py의
        GET /api/sessions/stream가 공유하는 정본.

        Args:
            limit: 초기 session_list 페이지 크기. 0이면 전체 (get_all_sessions
                기본값과 동일). api/sessions.py 라우터는 무인자 호출(전체),
                dashboard 라우터는 limit=Query(50, ge=0)로 50건 페이지.

        Yields:
            EventSourceResponse가 받는 dict — `{"event", "data"}` 또는
            `{"comment": "keepalive"}`.

        broadcaster는 lazy 호출 — 기존 두 핸들러(api/sessions.py sessions_stream과
        dashboard/routes/sessions.py api_sessions_stream)가 모두 event_generator
        클로저 안에서 get_session_broadcaster()를 호출하던 패턴을 그대로 이관한다.
        모듈 레벨 import는 import 사이클 위험이 있어 함수 body에 둔다.
        """
        from soul_server.service.session_broadcaster import get_session_broadcaster

        sessions, total = await self.get_all_sessions(offset=0, limit=limit)
        yield {
            "event": "session_list",
            "data": json.dumps(
                {"type": "session_list", "sessions": sessions, "total": total},
                ensure_ascii=False, default=str,
            ),
        }

        session_broadcaster = get_session_broadcaster()
        event_queue = session_broadcaster.add_client()
        try:
            while True:
                try:
                    item = await asyncio.wait_for(event_queue.get(), timeout=30.0)
                    # disconnect_all sentinel — None 수신 시 종료
                    if item is None:
                        break
                    # Phase 1: SSE id 필드는 미사용. _eid는 Phase 2에서 사용.
                    _eid, event = item
                    yield {
                        "event": event.get("type", "unknown"),
                        "data": json.dumps(event, ensure_ascii=False, default=str),
                    }
                except asyncio.TimeoutError:
                    yield {"comment": "keepalive"}
        finally:
            session_broadcaster.remove_client(event_queue)


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
