"""
TaskManager - 세션 라이프사이클 관리

세션(agent_session_id) 기반 아키텍처의 핵심 컴포넌트.
클라이언트의 실행 요청을 세션 단위로 관리하고,
결과를 영속화하여 클라이언트 재시작 시에도 복구 가능하게 합니다.

이 모듈은 다음 서브모듈들을 조합합니다:
- task_models: 데이터 모델 및 예외
- postgres_session_db: PostgreSQL 영속화
- task_listener: SSE 리스너 관리
- task_executor: 백그라운드 실행
"""

import asyncio
import logging
from datetime import timedelta
from pathlib import Path
from typing import Optional, Dict, List, Union, TYPE_CHECKING

if TYPE_CHECKING:
    from soul_server.service.agent_registry import AgentRegistry

from soul_server.service.task_models import (
    Task,
    TaskStatus,
    TaskConflictError,
    TaskNotFoundError,
    TaskNotRunningError,
    NodeMismatchError,
    generate_agent_session_id,
    utc_now,
    datetime_to_str,
    str_to_datetime,
)
from soul_server.service.task_listener import TaskListenerManager
from soul_server.service.task_executor import TaskExecutor
from soul_server.service.postgres_session_db import PostgresSessionDB
from soul_server.service.session_broadcaster import get_session_broadcaster
from soul_server.service.session_eviction_manager import SessionEvictionManager

# Re-export for backward compatibility
__all__ = [
    "Task",
    "TaskStatus",
    "TaskConflictError",
    "TaskNotFoundError",
    "TaskNotRunningError",
    "NodeMismatchError",
    "TaskManager",
    "task_manager",
    "get_task_manager",
    "set_task_manager",
    "utc_now",
    "generate_agent_session_id",
]

logger = logging.getLogger(__name__)


class TaskManager:
    """
    세션 라이프사이클 관리자

    역할:
    1. 세션(agent_session_id) 생성/조회/삭제
    2. agent_session_id로 활성 세션 추적 (중복 방지)
    3. 세션 상태 업데이트 및 결과 저장
    4. SSE 리스너 관리 (via TaskListenerManager)
    5. 개입 메시지 큐 관리
    6. JSON 파일 영속화 (via TaskStorage)
    7. 백그라운드 실행 (via TaskExecutor)
    """

    def __init__(
        self,
        session_db: PostgresSessionDB,
        eviction_ttl: int = 900,
        metadata_extractor=None,
        agent_registry: Optional["AgentRegistry"] = None,
    ):
        """
        Args:
            session_db: PostgreSQL 기반 세션 저장소
            eviction_ttl: 완료 세션 메모리 퇴거 TTL (초, 기본 15분)
            metadata_extractor: MetadataExtractor 인스턴스 (tool_result에서 자동 감지)
            agent_registry: AgentRegistry 인스턴스 (profile_id 유효성 검사용)
        """
        # 핵심 데이터 (key = agent_session_id)
        self._tasks: Dict[str, Task] = {}
        self._lock = asyncio.Lock()
        # claude_session_id → agent_session_id 역방향 인덱스
        self._session_index: Dict[str, str] = {}

        # AgentRegistry (profile_id 유효성 검사용)
        self._agent_registry = agent_registry

        # PostgreSQL 기반 세션 저장소
        self._db = session_db

        # LRU 퇴거 관리
        self._eviction_manager = SessionEvictionManager(
            tasks=self._tasks,
            eviction_ttl=eviction_ttl,
        )

        # 서브 컴포넌트들
        self._listener_manager = TaskListenerManager(self._tasks)
        self._executor = TaskExecutor(
            tasks=self._tasks,
            listener_manager=self._listener_manager,
            get_intervention_func=self.get_intervention,
            finalize_task_func=self.finalize_task,
            register_session_func=self.register_session,
            session_db=session_db,
            metadata_extractor=metadata_extractor,
            append_metadata_func=self.append_session_metadata,
            agent_registry=self._agent_registry,
        )

    # === claude_session_id 인덱스 ===

    def register_session(
        self,
        claude_session_id: str,
        agent_session_id: str,
        agent_id: Optional[str] = None,
    ) -> None:
        """claude_session_id → agent_session_id 매핑 등록

        SoulEngineAdapter가 session 이벤트를 발행할 때 호출합니다.
        task.claude_session_id를 여기서 저장함으로써 graceful_shutdown 시
        pre_shutdown_sessions.json에 유효한 claude_session_id가 기록된다.

        asyncio 단일 이벤트 루프 특성상, 이 동기 함수는 await 지점 없이
        실행되므로 complete_task()의 _lock 없이도 레이스 컨디션이 발생하지 않는다.

        agent_id: Phase 3에서 _SESSION_COLUMNS에 agent_id가 추가되면 DB에 저장됨.
        """
        self._session_index[claude_session_id] = agent_session_id
        # task.claude_session_id 즉시 저장: complete_task()보다 먼저 재시작이 오더라도 resume 가능
        task = self._tasks.get(agent_session_id)
        if task:
            task.claude_session_id = claude_session_id
        logger.info(f"Session index registered: {claude_session_id} -> {agent_session_id}")

    def get_task_by_claude_session(self, claude_session_id: str) -> Optional[Task]:
        """claude_session_id로 태스크 조회"""
        agent_session_id = self._session_index.get(claude_session_id)
        if not agent_session_id:
            return None
        return self._tasks.get(agent_session_id)

    def _unregister_claude_session(self, agent_session_id: str) -> None:
        """agent_session_id에 해당하는 claude_session_id 인덱스 제거"""
        to_remove = [
            sid for sid, asid in self._session_index.items()
            if asid == agent_session_id
        ]
        for sid in to_remove:
            del self._session_index[sid]
            logger.debug(f"Claude session index removed: {sid}")

    # === 로드/저장 ===

    async def load(self) -> int:
        """SessionDB에서 세션 메타데이터를 로드하고 퇴거 루프를 시작한다.

        running 상태 세션만 _tasks에 올리고 나머지는 DB에서 온디맨드 조회한다.
        """
        sessions, total = await self._db.get_all_sessions(node_id=self._db.node_id)

        loaded = 0
        zombies = 0
        for s in sessions:
            if s["status"] == TaskStatus.RUNNING.value:
                # 좀비 세션 정리: was_running_at_shutdown=0인 running 세션은
                # graceful shutdown 이전에 프로세스가 죽은 것이므로 completed로 전환
                if not s.get("was_running_at_shutdown", 0):
                    await self._db.update_session_status(
                        s["session_id"],
                        TaskStatus.COMPLETED.value,
                    )
                    zombies += 1
                    continue

                # was_running_at_shutdown=1인 running 세션: DB에서 interrupted로 전환 후 _tasks에 올림
                # 이렇게 해야 startup resume 시 add_intervention이 auto_resumed=True 경로를 타서
                # start_execution이 호출된다.
                try:
                    await self._db.update_session_status(
                        s["session_id"],
                        TaskStatus.INTERRUPTED.value,
                    )
                except Exception as e:
                    logger.warning(
                        f"Failed to transition session {s['session_id']} to interrupted: {e}"
                    )
                    continue

                try:
                    task = Task(
                        agent_session_id=s["session_id"],
                        prompt=s.get("prompt", ""),
                        status=TaskStatus.INTERRUPTED,
                        client_id=s.get("client_id"),
                        claude_session_id=s.get("claude_session_id"),
                        session_type=s.get("session_type", "claude"),
                        last_event_id=s.get("last_event_id", 0),
                        last_read_event_id=s.get("last_read_event_id", 0),
                        created_at=str_to_datetime(s["created_at"]),
                        node_id=s.get("node_id"),
                    )
                    self._tasks[s["session_id"]] = task
                    loaded += 1
                except (ValueError, KeyError) as e:
                    logger.warning(f"Failed to load session {s['session_id']}: {e}")

        if zombies:
            logger.info(f"Cleaned up {zombies} zombie sessions (running without shutdown flag)")
        if loaded:
            logger.info(f"Transitioned {loaded} shutdown sessions to interrupted status")
        logger.info(f"Loaded {loaded} running sessions from DB (total {total} in catalog)")

        # 퇴거 루프 시작
        self._eviction_manager.start()

        return loaded

    # === 내부 헬퍼 ===

    async def _assign_default_folder_and_broadcast(
        self, session_id: str, session_type: str, folder_id: str | None = None
    ) -> None:
        """새 세션을 폴더에 배정하고 catalog_updated를 브로드캐스트한다.

        folder_id가 지정되면 해당 폴더에 배치하고,
        미지정이면 session_type 기반 기본 폴더에 자동 배정한다.

        부가 기능이므로, 폴더 배정이나 브로드캐스트에 실패해도
        호출자의 핵심 동작(세션 생성/등록)에 영향을 주지 않는다.
        """
        if folder_id is not None:
            await self._db.assign_session_to_folder(session_id, folder_id)
            folder = {"id": folder_id}
        else:
            default_name = PostgresSessionDB.DEFAULT_FOLDERS.get(
                session_type, PostgresSessionDB.DEFAULT_FOLDERS["claude"]
            )
            folder = await self._db.get_default_folder(default_name)
            if folder:
                await self._db.assign_session_to_folder(session_id, folder["id"])

        try:
            broadcaster = get_session_broadcaster()
            if folder:
                catalog = await self._db.get_catalog()
                await broadcaster.broadcast({
                    "type": "catalog_updated",
                    "catalog": catalog,
                })
        except Exception:
            logger.warning(
                f"Failed to broadcast catalog for {session_id}",
                exc_info=True,
            )

    # === CRUD 작업 ===

    async def register_external_task(self, task: Task) -> None:
        """외부에서 생성된 태스크를 등록한다.

        LLM 프록시 등 TaskManager의 create_task 흐름을 거치지 않는
        외부 모듈이 직접 생성한 Task를 등록할 때 사용합니다.

        Args:
            task: 등록할 Task 인스턴스
        """
        task.node_id = self._db.node_id
        async with self._lock:
            self._tasks[task.agent_session_id] = task
        await self._db.upsert_session(
            task.agent_session_id,
            status=task.status.value,
            prompt=task.prompt,
            session_type=task.session_type,
            client_id=task.client_id,
            claude_session_id=task.claude_session_id,
            created_at=datetime_to_str(task.created_at),
            node_id=self._db.node_id,
            agent_id=task.profile_id,
        )

        # 기본 폴더 자동 배정 + 카탈로그 브로드캐스트
        await self._assign_default_folder_and_broadcast(
            task.agent_session_id, task.session_type
        )

    async def finalize_task(
        self,
        agent_session_id: str,
        *,
        result: Optional[str] = None,
        error: Optional[str] = None,
        **metadata,
    ) -> Optional[Task]:
        """태스크를 완료 또는 에러로 마무리한다.

        result가 제공되면 COMPLETED, error가 제공되면 ERROR 상태로 전환합니다.
        metadata의 키가 Task 필드와 일치하면 해당 필드도 업데이트합니다.

        Args:
            agent_session_id: 세션 식별자
            result: 성공 결과 (COMPLETED 전환)
            error: 에러 메시지 (ERROR 전환)
            **metadata: 추가 메타데이터 (llm_usage 등)

        Returns:
            업데이트된 태스크 (없으면 None)

        Raises:
            ValueError: result와 error가 모두 None인 경우
        """
        if result is None and error is None:
            raise ValueError("finalize_task requires either result= or error=")

        async with self._lock:
            task = self._tasks.get(agent_session_id)
            if not task:
                logger.warning(f"Task not found for finalize: {agent_session_id}")
                return None

            if result is not None:
                task.status = TaskStatus.COMPLETED
                task.result = result
            elif error is not None:
                task.status = TaskStatus.ERROR
                task.error = error

            task.completed_at = utc_now()

            # 추가 메타데이터 설정
            for key, value in metadata.items():
                if hasattr(task, key):
                    setattr(task, key, value)

        # DB 업데이트 + LRU 퇴거 후보 등록
        # claude_session_id는 metadata로 전달되었거나 register_claude_session으로 설정된 값을 사용한다.
        # complete_task()와 동일하게 claude_session_id를 DB에 기록하여 다음 resume 시 사용 가능하게 한다.
        await self._db.upsert_session(
            agent_session_id,
            status=task.status.value,
            claude_session_id=task.claude_session_id,
            updated_at=datetime_to_str(task.completed_at),
            node_id=task.node_id,
        )
        self._eviction_manager.register(agent_session_id)
        # complete_task() / error_task()와 동일하게 claude_session_id 인덱스를 제거한다.
        self._unregister_claude_session(agent_session_id)
        try:
            await get_session_broadcaster().emit_session_updated(task)
        except Exception:
            logger.warning(f"Failed to broadcast finalize for {agent_session_id}", exc_info=True)
        return task

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

        Returns:
            (세션 dict 리스트, 전체 세션 수) 튜플
        """
        sessions, total = await self._db.get_all_sessions(
            offset=offset, limit=limit, session_type=session_type,
            folder_id=folder_id, node_id=node_id, status=status,
        )

        result = []
        for s in sessions:
            session_id = s["session_id"]
            # running 세션의 pid를 _tasks에서 보충
            task = self._tasks.get(session_id)
            pid = task.pid if task else None
            created_at = s.get("created_at")
            # running 세션의 last_event_id는 Task 메모리에서 보충
            last_event_id = task.last_event_id if task else s.get("last_event_id", 0)
            last_read_event_id = task.last_read_event_id if task else s.get("last_read_event_id", 0)
            updated_at = s.get("updated_at") or created_at
            info = {
                "agent_session_id": session_id,
                "status": s.get("status"),
                "prompt": s.get("prompt"),
                "created_at": created_at.isoformat() if created_at else None,
                "updated_at": updated_at.isoformat() if updated_at else None,
                "pid": pid,
                "session_type": s.get("session_type") or "claude",
                "last_message": s.get("last_message"),
                "metadata": s.get("metadata") or [],
                "last_event_id": last_event_id,
                "last_read_event_id": last_read_event_id,
                "display_name": s.get("display_name"),
                "node_id": s.get("node_id"),
            }
            if s.get("session_type", "claude") != "claude":
                info["llm_provider"] = s.get("llm_provider")
                info["llm_model"] = s.get("llm_model")
                info["llm_usage"] = s.get("llm_usage")
                info["client_id"] = s.get("client_id")
            result.append(info)
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

    async def create_task(
        self,
        prompt: str,
        agent_session_id: Optional[str] = None,
        client_id: Optional[str] = None,
        allowed_tools: Optional[List[str]] = None,
        disallowed_tools: Optional[List[str]] = None,
        use_mcp: bool = True,
        context: Optional[dict] = None,
        context_items: Optional[List[dict]] = None,
        extra_context_items: Optional[List[dict]] = None,
        model: Optional[str] = None,
        folder_id: Optional[str] = None,
        system_prompt: Optional[str] = None,
        profile_id: Optional[str] = None,
    ) -> Task:
        """
        새 세션 태스크 생성 또는 기존 세션 resume

        Args:
            prompt: 실행할 프롬프트
            agent_session_id: 세션 식별자 (None이면 서버가 생성, 제공하면 resume)
            client_id: 클라이언트 식별자 (메타데이터)
            allowed_tools: 허용 도구 목록
            disallowed_tools: 금지 도구 목록
            use_mcp: MCP 서버 연결 여부
            context: 구조화된 맥락 (dict, StructuredContext.model_dump() 결과)
            context_items: StructuredContext.items에서 추출한 맥락 항목 (Pydantic 검증 완료)
            extra_context_items: 클라이언트가 직접 전달한 추가 맥락 항목 (raw dict)
            folder_id: 세션을 배치할 폴더 ID (None이면 session_type 기반 자동 배정)
            system_prompt: Claude API system 파라미터로 전달할 시스템 프롬프트
            profile_id: 에이전트 프로필 ID (AgentRegistry에서 유효성 검사)

        Returns:
            Task: 생성되거나 재활성화된 태스크

        Raises:
            TaskConflictError: 해당 세션에 이미 running 태스크가 존재
            ValueError: 존재하지 않는 profile_id가 지정된 경우
        """
        # profile_id 유효성 검사 (registry가 있을 때만)
        if profile_id is not None and self._agent_registry is not None:
            if not self._agent_registry.has(profile_id):
                raise ValueError(f"존재하지 않는 에이전트 프로필: {profile_id}")

        # 두 소스 병합: StructuredContext.items + 클라이언트 직접 전달분
        merged = (context_items or []) + (extra_context_items or [])
        effective_context_items = merged or None

        is_resume = agent_session_id is not None

        if not is_resume:
            agent_session_id = generate_agent_session_id()

        async with self._lock:
            existing = self._tasks.get(agent_session_id)

            # 퇴거된 세션의 resume 지원: _tasks에 없으면 카탈로그/저장소에서 복원
            if not existing and is_resume:
                existing = await self._eviction_manager.load_evicted_task(self._db, agent_session_id)
                if existing:
                    # 다른 노드 소속 세션은 이 노드에서 resume 불가
                    session_node_id = existing.node_id
                    if session_node_id is not None and session_node_id != self._db.node_id:
                        raise NodeMismatchError(session_node_id, self._db.node_id)
                    self._tasks[agent_session_id] = existing
                    logger.info(f"Restored evicted session for resume: {agent_session_id}")

            if existing:
                if existing.status == TaskStatus.RUNNING:
                    raise TaskConflictError(f"Session already running: {agent_session_id}")

                # 완료/에러 세션 → resume
                resume_session_id = existing.claude_session_id
                logger.info(f"Resuming session: {agent_session_id} (claude_session={resume_session_id})")

                # DB에서 기존 metadata 로드 (메모리 퇴거 후 resume 시에도 유지)
                db_session = await self._db.get_session(agent_session_id)
                if db_session and db_session.get("metadata"):
                    existing.metadata = db_session["metadata"]

                # 기존 태스크를 RUNNING으로 재활성화
                existing.prompt = prompt
                existing.status = TaskStatus.RUNNING
                existing.resume_session_id = resume_session_id
                existing.result = None
                existing.error = None
                existing.completed_at = None
                existing.last_progress_text = None
                existing.intervention_queue = asyncio.Queue()
                existing.allowed_tools = allowed_tools
                existing.disallowed_tools = disallowed_tools
                existing.use_mcp = use_mcp
                existing.context = context
                existing.context_items = effective_context_items
                existing.model = model
                existing.system_prompt = system_prompt
                existing.profile_id = profile_id
                if client_id:
                    existing.client_id = client_id

                # 퇴거 후보에서 제거
                self._eviction_manager.unregister(agent_session_id)

                task = existing
                is_new = False
            else:
                # 새 세션
                task = Task(
                    agent_session_id=agent_session_id,
                    prompt=prompt,
                    client_id=client_id,
                    allowed_tools=allowed_tools,
                    disallowed_tools=disallowed_tools,
                    use_mcp=use_mcp,
                    context=context,
                    context_items=effective_context_items,
                    model=model,
                    system_prompt=system_prompt,
                    profile_id=profile_id,
                )
                self._tasks[agent_session_id] = task
                logger.info(f"Created new session: {agent_session_id}")
                is_new = True

        if not is_resume:
            task.node_id = self._db.node_id

        # DB에 세션 등록/업데이트
        await self._db.upsert_session(
            agent_session_id,
            status=TaskStatus.RUNNING.value,
            prompt=prompt,
            session_type=task.session_type,
            client_id=task.client_id,
            claude_session_id=task.claude_session_id,
            created_at=datetime_to_str(task.created_at),
            node_id=task.node_id if is_resume else self._db.node_id,
            agent_id=task.profile_id,
        )

        # 새 세션이면 폴더에 배치 + 카탈로그 브로드캐스트
        if is_new:
            await self._assign_default_folder_and_broadcast(
                agent_session_id, task.session_type, folder_id=folder_id
            )

        # 세션 목록 변경을 대시보드에 브로드캐스트 (부가 기능 — 실패해도 태스크 생성에 영향 없음)
        try:
            broadcaster = get_session_broadcaster()
            if is_new:
                await broadcaster.emit_session_created(task)
            else:
                await broadcaster.emit_session_updated(task)
        except Exception:
            logger.warning(f"Failed to broadcast session event for {agent_session_id}", exc_info=True)

        return task

    async def get_task(self, agent_session_id: str) -> Optional[Task]:
        """세션 태스크 조회

        1. _tasks에서 먼저 조회 (running + LRU 캐시 히트)
        2. 퇴거 후보에 있으면 LRU TTL 갱신
        3. _tasks에 없으면 저장소에서 on-demand 로드 (메모리에 상주시키지 않음)
        """
        task = self._tasks.get(agent_session_id)
        if task:
            # LRU 캐시 히트 → TTL 갱신
            if self._eviction_manager.is_candidate(agent_session_id):
                self._eviction_manager.register(agent_session_id)
            return task

        # on-demand 로드 (퇴거된 세션)
        return await self._eviction_manager.load_evicted_task(self._db, agent_session_id)

    # === SSE 리스너 관리 (위임) ===

    async def add_listener(self, agent_session_id: str, queue: asyncio.Queue) -> bool:
        """SSE 리스너 추가"""
        async with self._lock:
            return await self._listener_manager.add_listener(agent_session_id, queue)

    async def remove_listener(self, agent_session_id: str, queue: asyncio.Queue) -> None:
        """SSE 리스너 제거"""
        async with self._lock:
            await self._listener_manager.remove_listener(agent_session_id, queue)

    async def broadcast(self, agent_session_id: str, event: dict) -> int:
        """모든 리스너에게 이벤트 브로드캐스트"""
        return await self._listener_manager.broadcast(agent_session_id, event)

    # === 개입 메시지 관리 ===

    async def add_intervention(
        self,
        agent_session_id: str,
        text: str,
        user: str,
        attachment_paths: Optional[List[str]] = None,
        skip_resume: bool = False,
    ) -> dict:
        """
        세션에 개입 메시지 추가 (자동 resume 포함)

        Running 세션이면 intervention queue에 추가합니다.
        완료/에러 세션이면 자동으로 resume하여 대화를 이어갑니다.
        퇴거된 세션도 on-demand 로드하여 처리합니다.

        Args:
            agent_session_id: 세션 식별자
            text: 메시지 텍스트
            user: 사용자
            attachment_paths: 첨부 파일 경로
            skip_resume: True이면 완료/퇴거 세션에 대한 auto-resume을 건너뜀 (graceful_shutdown용)

        Returns:
            결과 딕셔너리:
            - running: {"queue_position": int}
            - 자동 resume: {"auto_resumed": True, "agent_session_id": str}
            - skip_resume: {"skipped": True}

        Raises:
            TaskNotFoundError: 세션이 존재하지 않음 (skip_resume=False인 경우)
        """
        task = self._tasks.get(agent_session_id)

        if task and task.status == TaskStatus.RUNNING:
            # running 세션에 직접 개입
            message = {
                "text": text,
                "user": user,
                "attachment_paths": attachment_paths or [],
            }
            await task.intervention_queue.put(message)
            return {"queue_position": task.intervention_queue.qsize()}

        if skip_resume:
            return {"skipped": True}  # 완료/퇴거 세션 resume 건너뜀

        if not task:
            # 퇴거된 세션 on-demand 로드
            task = await self._eviction_manager.load_evicted_task(self._db, agent_session_id)
            if not task:
                raise TaskNotFoundError(f"Session not found: {agent_session_id}")

        # 완료/에러/중단 → 자동 resume (같은 세션 재활성화)
        await self.create_task(
            prompt=text,
            agent_session_id=agent_session_id,
            client_id=user,
        )

        return {
            "auto_resumed": True,
            "agent_session_id": agent_session_id,
        }

    async def append_session_metadata(
        self, agent_session_id: str, entry: dict
    ) -> None:
        """세션에 메타데이터 엔트리를 추가한다.

        Task.metadata에 append하고, SessionDB에 영속화하고,
        metadata_updated + session_updated SSE 이벤트를 브로드캐스트한다.

        Args:
            agent_session_id: 세션 식별자
            entry: 메타데이터 엔트리
                {type, value, label?, url?, timestamp, tool_name}
        """
        task = self._tasks.get(agent_session_id)
        if not task:
            logger.warning(f"Task not found for metadata append: {agent_session_id}")
            return

        # Task 메모리에 추가
        task.metadata.append(entry)

        # DB에 영속화
        await self._db.append_metadata(agent_session_id, entry)

        # SSE 브로드캐스트 (부가 기능 — 실패해도 메타데이터 저장에 영향 없음)
        try:
            broadcaster = get_session_broadcaster()
            # metadata_updated 이벤트
            await broadcaster.broadcast({
                "type": "metadata_updated",
                "session_id": agent_session_id,
                "entry": entry,
                "metadata": task.metadata,
            })
            # session_updated 이벤트 (세션 목록 실시간 갱신)
            await broadcaster.emit_session_updated(task)
        except Exception:
            logger.warning(
                f"Failed to broadcast metadata for {agent_session_id}",
                exc_info=True,
            )

    async def get_intervention(self, agent_session_id: str) -> Optional[dict]:
        """
        개입 메시지 가져오기 (non-blocking)

        Returns:
            메시지 dict 또는 None
        """
        task = self._tasks.get(agent_session_id)
        if not task:
            return None

        try:
            return task.intervention_queue.get_nowait()
        except asyncio.QueueEmpty:
            return None

    # === AskUserQuestion 응답 전달 ===

    def deliver_input_response(
        self,
        agent_session_id: str,
        request_id: str,
        answers: dict,
    ) -> bool:
        """AskUserQuestion에 대한 사용자 응답 전달

        Args:
            agent_session_id: 세션 식별자
            request_id: input_request 이벤트의 request_id
            answers: 질문별 응답 dict

        Returns:
            True: 전달 성공
            False: 세션 없음 또는 실행 중이 아님 또는 콜백 없음

        Raises:
            TaskNotFoundError: 세션이 존재하지 않음
            TaskNotRunningError: 세션이 실행 중이 아님
        """
        task = self._tasks.get(agent_session_id)
        if not task:
            raise TaskNotFoundError(f"Session not found: {agent_session_id}")

        if task.status != TaskStatus.RUNNING:
            raise TaskNotRunningError(f"Session not running: {agent_session_id}")

        deliver_fn = task._deliver_input_response
        if not callable(deliver_fn):
            logger.warning(
                f"deliver_input_response: 콜백 없음 "
                f"(session={agent_session_id}, request_id={request_id})"
            )
            return False

        return deliver_fn(request_id, answers)

    # === 백그라운드 실행 관리 (위임) ===

    async def start_execution(
        self,
        agent_session_id: str,
        claude_runner,
        resource_manager,
    ) -> bool:
        """세션의 Claude 실행을 백그라운드에서 시작"""
        return await self._executor.start_execution(
            agent_session_id, claude_runner, resource_manager
        )

    def is_execution_running(self, agent_session_id: str) -> bool:
        """세션 실행이 진행 중인지 확인"""
        return self._executor.is_execution_running(agent_session_id)

    async def send_reconnect_status(
        self,
        agent_session_id: str,
        queue: asyncio.Queue,
        last_event_id: Optional[int] = None,
    ) -> None:
        """재연결 시 현재 상태 이벤트 전송"""
        await self._executor.send_reconnect_status(
            agent_session_id, queue, last_event_id=last_event_id
        )

    # === 정리 ===

    async def cancel_running_tasks(self, timeout: float = 5.0) -> int:
        """실행 중인 모든 태스크 취소"""
        # 퇴거 루프 중지
        self._eviction_manager.stop()

        async with self._lock:
            return await self._executor.cancel_running_tasks(timeout)

    async def cleanup_orphaned_running(self, max_age_hours: int = 24) -> int:
        """
        고아 running 태스크 보정

        실행 태스크(execution_task)가 없는데 running 상태인 오래된 세션을
        interrupted로 마킹합니다. 완료/에러/중단된 세션은 삭제하지 않고
        메모리에 유지합니다 (대시보드 히스토리 조회용).

        Args:
            max_age_hours: orphaned 판정 기준 시간

        Returns:
            보정된 태스크 수
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
            # DB 업데이트 + 퇴거 후보 등록
            for task in fixed_tasks:
                await self._db.upsert_session(
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
        """통계 반환"""
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


# 싱글톤 인스턴스는 main.py에서 초기화
task_manager: Optional[TaskManager] = None


def get_task_manager() -> TaskManager:
    """TaskManager 싱글톤 반환"""
    global task_manager
    if task_manager is None:
        raise RuntimeError("TaskManager not initialized.")
    return task_manager


def set_task_manager(manager: Optional[TaskManager]) -> None:
    """TaskManager 인스턴스 설정 (테스트용)"""
    global task_manager
    task_manager = manager
