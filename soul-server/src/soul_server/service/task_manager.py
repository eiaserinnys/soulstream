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
from soul_server.service.session_query_service import init_session_query_service
# task_factory가 정본 — 내부 시그니처/호출용 import만 유지 (re-export 안 함)
from soul_server.service.task_factory import CreateTaskParams, TaskFactory
from soul_server.service.task_maintenance import TaskMaintenance
from soul_server.service.cross_node_relay import relay_cross_node_intervention
from soul_server.util.attachment_helpers import build_attachment_context_items
from soul_common.auth.caller_info import build_agent_caller_info

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
        self._listener_manager = TaskListenerManager()
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

        # 세션 조회 서비스 싱글턴 초기화
        init_session_query_service(self._db, self._tasks)

        # 세션 생성/재개 팩토리 (executor와 같은 DI 패턴)
        self._task_factory = TaskFactory(
            session_db=session_db,
            tasks=self._tasks,
            lock=self._lock,
            eviction_manager=self._eviction_manager,
            agent_registry=self._agent_registry,
            assign_default_folder=self._assign_default_folder_and_broadcast,
        )

        # 유지보수 작업 (취소/고아 보정/통계)
        self._task_maintenance = TaskMaintenance(
            tasks=self._tasks,
            lock=self._lock,
            eviction_manager=self._eviction_manager,
            executor=self._executor,
            session_db=session_db,
        )

    # === Sub-service property 접근자 ===

    @property
    def listener_manager(self) -> TaskListenerManager:
        """SSE 리스너 관리자"""
        return self._listener_manager

    @property
    def executor(self) -> "TaskExecutor":
        """백그라운드 실행 관리자"""
        return self._executor

    # === claude_session_id 인덱스 ===

    async def register_session(
        self,
        claude_session_id: str,
        agent_session_id: str,
    ) -> None:
        """claude_session_id를 DB에 설정한다 (idempotent).

        DB 레이어에서 불변성 보장:
        - NULL → SET (최초 설정)
        - 같은 값 → no-op (컴팩션/재시작 재진입 정상 처리)
        - 다른 값 → EXCEPTION (버그 탐지)

        create_task()에서 이미 pending 행(claude_session_id=NULL)이 INSERT되어 있으므로,
        이 메서드는 UPDATE only (set_claude_session_id 프로시저 호출).
        """
        task = self._tasks.get(agent_session_id)
        in_memory_existing = task.claude_session_id if task else None
        logger.info(
            f"register_session: claude_session_id={claude_session_id}, "
            f"agent_session_id={agent_session_id}, "
            f"in_memory_existing={in_memory_existing}"
        )

        self._session_index[claude_session_id] = agent_session_id
        preserve_existing = (
            task is not None
            and task.preserve_claude_session_id_on_register
            and task.claude_session_id is not None
            and task.claude_session_id != claude_session_id
        )
        if preserve_existing:
            logger.info(
                f"register_session: fresh Claude session observed for "
                f"agent_session_id={agent_session_id}; preserving canonical "
                f"claude_session_id={task.claude_session_id}, runtime_index_added={claude_session_id}"
            )
            try:
                await get_session_broadcaster().emit_session_updated(task)
            except Exception:
                logger.warning(f"Failed to emit session_updated for {agent_session_id}", exc_info=True)
            return

        # 인메모리 Task에 즉시 반영: complete_task()보다 먼저 재시작이 와도 resume 가능
        if task:
            task.claude_session_id = claude_session_id

        # DB 불변성은 session_set_claude_id 프로시저가 보장
        # 같은 값이면 no-op, 다른 값이면 EXCEPTION
        try:
            await self._db.set_claude_session_id(agent_session_id, claude_session_id)
            logger.info(f"Session registered (4-ID): {claude_session_id} -> {agent_session_id}")
        except Exception as e:
            logger.error(
                f"register_session DB failed: agent_session_id={agent_session_id}, "
                f"claude_session_id={claude_session_id}, error={e}"
            )
            raise

        # session_updated 브로드캐스트 (claude_session_id 확정 알림 — 부가 기능)
        if task:
            try:
                await get_session_broadcaster().emit_session_updated(task)
            except Exception:
                logger.warning(f"Failed to emit session_updated for {agent_session_id}", exc_info=True)

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
        sessions, total = await self._db.get_all_sessions(
            node_id=self._db.node_id,
            status=TaskStatus.RUNNING.value,
        )

        loaded = 0
        for s in sessions:
            # 재시작 복구: 서버 기동 시 RUNNING 세션은 모두 INTERRUPTED로 전환 → 재개 가능
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
                    caller_session_id=s.get("caller_session_id"),
                    profile_id=s.get("agent_id"),
                )
                self._tasks[s["session_id"]] = task
                loaded += 1
            except (ValueError, KeyError) as e:
                logger.warning(f"Failed to load session {s['session_id']}: {e}")

        if loaded:
            logger.info(f"Transitioned {loaded} shutdown sessions to interrupted status")
        logger.info(f"Loaded {loaded} running sessions from DB (total {total} in catalog)")

        # 퇴거 루프 시작
        self._eviction_manager.start()

        return loaded

    # === 내부 헬퍼 ===

    async def _assign_default_folder_and_broadcast(
        self, session_id: str, session_type: str, folder_id: str | None = None
    ) -> str | None:
        """새 세션을 폴더에 배정하고 catalog_updated를 브로드캐스트한다.

        folder_id가 지정되면 해당 폴더에 배치하고,
        미지정이면 session_type 기반 기본 폴더에 자동 배정한다.

        부가 기능이므로, 폴더 배정이나 브로드캐스트에 실패해도
        호출자의 핵심 동작(세션 생성/등록)에 영향을 주지 않는다.

        Returns:
            배정된 folder_id. 폴더가 없거나 배정되지 않으면 None.
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

        return folder["id"] if folder else None

    # === CRUD 작업 ===

    async def register_external_task(self, task: Task) -> None:
        """외부에서 생성된 태스크를 등록한다.

        LLM 프록시 등 TaskManager의 create_task 흐름을 거치지 않는
        외부 모듈이 직접 생성한 Task를 등록할 때 사용합니다.

        caller_info 처리는 TaskFactory._register_new_session_async와 동일하게
        신규 세션에만 metadata 영속화 (대칭성 — design-principles §9).

        Args:
            task: 등록할 Task 인스턴스
        """
        task.node_id = self._db.node_id
        async with self._lock:
            self._tasks[task.agent_session_id] = task
        # LLM 세션은 claude_session_id가 없으므로 None으로 등록한다
        await self._db.register_session_initial(
            session_id=task.agent_session_id,
            node_id=self._db.node_id,
            agent_id=task.profile_id,
            claude_session_id=None,
            session_type=task.session_type,
            prompt=task.prompt,
            client_id=task.client_id,
            status=task.status.value,
            created_at=task.created_at,
            caller_session_id=task.caller_session_id,
        )

        # caller_info를 Task.metadata와 DB에 동시 저장 (TaskFactory와 동일 패턴)
        # session_created 이벤트 전 타이밍 — append_session_metadata 사용 시
        # metadata_updated/session_updated가 session_created보다 먼저 발행되어 클라이언트 혼동.
        if task.caller_info:
            entry = {"type": "caller_info", "value": task.caller_info}
            task.metadata.append(entry)
            await self._db.append_metadata(task.agent_session_id, entry)

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

            # 락 블록 안에서 로컬 변수로 추출 (완료 보고 코드는 락 바깥에서 실행)
            caller_session_id_to_notify = task.caller_session_id
            task_result = task.result
            task_error = task.error

        # DB 업데이트 + LRU 퇴거 후보 등록
        # 불변 필드는 register_session()에서만 기록한다.
        # finalize_task는 상태와 완료 시각만 업데이트한다.
        await self._db.update_session(
            agent_session_id,
            status=task.status.value,
            updated_at=datetime_to_str(task.completed_at),
        )
        self._eviction_manager.register(agent_session_id)
        # complete_task() / error_task()와 동일하게 claude_session_id 인덱스를 제거한다.
        self._unregister_claude_session(agent_session_id)
        try:
            await get_session_broadcaster().emit_session_updated(task)
        except Exception:
            logger.warning(f"Failed to broadcast finalize for {agent_session_id}", exc_info=True)

        # 완료 보고 — add_intervention이 동일 락을 획득하므로 반드시 락 블록 바깥에서 실행
        if caller_session_id_to_notify:
            await self._notify_caller_completion(
                task, caller_session_id_to_notify, task_result, task_error
            )

        return task

    async def _notify_caller_completion(
        self,
        completed_task: Task,
        caller_session_id: str,
        result_text: Optional[str],
        error_text: Optional[str],
    ) -> None:
        """완료된 세션의 결과를 caller 세션에 인터벤션으로 통지한다.

        caller 세션이 이미 완료 상태이면 auto-resume하고 실행을 시작한다.
        로컬 통지 실패 시 cross-node 릴레이를 시도한다.

        finalize_task()의 락 블록 바깥에서 호출되어야 한다
        (add_intervention이 동일 락을 획득하므로).

        F-11B fix(2026-05-09, atom F-11): 발신자는 완료된 자식 task의 agent —
        build_agent_caller_info(통합 v1) 정본 패턴으로 caller_info를 조립하여
        자식 agent의 신원이 caller 세션 표시에 정확히 반영되게 한다 (이전엔 미박음 →
        dashboard owner Google portrait fallback 결함).
        """
        agent_session_id = completed_task.agent_session_id

        # caller_info 조립 — 자식 task의 profile_id 기반 (create_agent_session·#15 helper 정합)
        caller_profile = None
        if completed_task.profile_id and self._agent_registry:
            caller_profile = self._agent_registry.get(completed_task.profile_id)
        caller_info = build_agent_caller_info(
            agent_node=self._db.node_id,
            agent_id=completed_task.profile_id,
            agent_name=caller_profile.name if caller_profile else None,
            portrait_path=caller_profile.portrait_path if caller_profile else None,
        )

        if result_text:
            notify_text = f"✅ 에이전트 세션 완료 (ID: `{agent_session_id}`)\n\n{result_text}"
        else:
            notify_text = f"❌ 에이전트 세션 오류 (ID: `{agent_session_id}`)\n\n{error_text or ''}"

        try:
            intervention_result = await self.add_intervention(
                agent_session_id=caller_session_id,
                text=notify_text,
                user="agent",
                caller_info=caller_info,
            )
            logger.info(
                f"Completion notification sent to caller {caller_session_id} "
                f"from {agent_session_id}"
            )
            # caller session이 이미 completed 상태였다면 add_intervention()이
            # create_task()로 RUNNING으로 전환하고 auto_resumed=True를 반환한다.
            # 이 경우 start_execution()을 호출해야 Claude Code가 실제로 실행된다.
            # (api_intervene()과 동일한 패턴 — 반환값을 무시하면 DB만 RUNNING이고
            #  실제 실행이 없는 zombie 상태가 된다.)
            if intervention_result.get("auto_resumed"):
                from soul_server.service.resource_manager import resource_manager as _rm
                from soul_server.service.engine_adapter import get_soul_engine as _get_engine
                await self._executor.start_execution(
                    agent_session_id=caller_session_id,
                    claude_runner=_get_engine(),
                    resource_manager=_rm,
                )
                logger.info(
                    f"Auto-resumed caller session {caller_session_id} "
                    f"after child {agent_session_id} completed"
                )
        except Exception as local_err:
            logger.warning(
                f"Local notification to caller {caller_session_id} failed: {local_err}",
                exc_info=True,
            )
            await relay_cross_node_intervention(
                caller_session_id, notify_text, caller_info=caller_info
            )

    # === 세션 조회 → get_session_query_service() 직접 사용 ===
    # (분리됨: get_running_tasks, get_all_sessions, list_sessions_summary, get_all_folders)

    async def create_task(self, params: CreateTaskParams) -> Task:
        """새 세션 생성 또는 기존 세션 재개. 실 동작은 TaskFactory에 위임.

        Args:
            params: CreateTaskParams 인스턴스 (필드 의미는 dataclass 정의 참조).

        Returns:
            Task: 생성되거나 재활성화된 태스크.

        Raises:
            TaskConflictError: 해당 세션에 이미 running 태스크가 존재.
            NodeMismatchError: 다른 노드 소속 세션의 resume 시도.
            ValueError: 존재하지 않는 profile_id가 지정된 경우.
        """
        task, _ = await self._task_factory.create_or_resume(params)
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

    async def interrupt_task(self, agent_session_id: str) -> bool:
        """진행 중인 세션 turn을 즉시 중단한다.

        상태 전환은 interrupt 신호보다 먼저 기록한다. Claude SDK가 interrupt 후
        ResultMessage를 반환해도 TaskExecutor가 completed/error로 덮지 않게 하기 위해서다.
        """
        async with self._lock:
            task = self._tasks.get(agent_session_id)
            if not task:
                raise TaskNotFoundError(f"Session not found: {agent_session_id}")
            if task.status != TaskStatus.RUNNING:
                raise TaskNotRunningError(f"Session not running: {agent_session_id}")

            runner = getattr(task, "_runner", None)
            execution_task = task.execution_task
            task.status = TaskStatus.INTERRUPTED
            task.completed_at = utc_now()

        interrupted = False
        if runner is not None and hasattr(runner, "interrupt"):
            try:
                interrupted = bool(runner.interrupt())
            except Exception:
                logger.warning(
                    "Runner interrupt failed for %s",
                    agent_session_id,
                    exc_info=True,
                )

        if not interrupted and execution_task is not None and not execution_task.done():
            execution_task.cancel()
            interrupted = True

        await self._db.update_session(
            agent_session_id,
            status=TaskStatus.INTERRUPTED.value,
            updated_at=datetime_to_str(task.completed_at),
        )
        self._eviction_manager.register(agent_session_id)
        self._unregister_claude_session(agent_session_id)
        try:
            await get_session_broadcaster().emit_session_updated(task)
        except Exception:
            logger.warning(
                f"Failed to broadcast interrupt for {agent_session_id}",
                exc_info=True,
            )

        return interrupted

    # === SSE 리스너 관리 → task_manager.listener_manager 직접 사용 ===
    # (pass-through 제거됨: add_listener, remove_listener, broadcast)

    # === 개입 메시지 관리 ===

    async def add_intervention(
        self,
        agent_session_id: str,
        text: str,
        user: str,
        attachment_paths: Optional[List[str]] = None,
        skip_resume: bool = False,
        caller_info: Optional[dict] = None,
        context_items: Optional[List[dict]] = None,
        extra_context_items: Optional[List[dict]] = None,
    ) -> dict:
        """
        세션에 개입 메시지 추가 (자동 resume 포함) — submit_message 위임 wrapper.

        본 메서드는 ``submit_message`` 정본(``message_submission_service``)의 backward-compat
        wrapper다. running 큐잉/terminal auto-resume 분기 자체는 ``submit_message``가 단일
        정본으로 보유하고(``design-principles §3``), 본 메서드는 (1) graceful_shutdown용
        ``skip_resume=True`` 특수 처리와 (2) 기존 호출자(``_notify_caller_completion``,
        cross-node relay 등)와의 시그니처·반환 형식 호환만 담당한다.

        terminal 분기에서도 일반 resume은 기존 ``claude_session_id``를 ``task.resume_session_id``로
        전달한다.

        Args:
            agent_session_id: 세션 식별자
            text: 메시지 텍스트
            user: 사용자
            attachment_paths: 첨부 파일 경로
            skip_resume: True이면 완료/퇴거 세션에 대한 auto-resume을 건너뜀 (graceful_shutdown용).
                running 세션이면 본 플래그와 무관하게 큐잉된다 (기존 동작 보존).
            caller_info: 발신자 신원(통합 v1). F-9 fix(2026-05-08).
            context_items: 개입 turn에만 추가할 컨텍스트.
            extra_context_items: 개입 turn에만 추가할 확장 컨텍스트.

        Returns:
            결과 딕셔너리:
            - running: {"queue_position": int}
            - 자동 resume: {"auto_resumed": True, "agent_session_id": str}
            - skip_resume + non-running: {"skipped": True}

        Raises:
            TaskNotFoundError: 세션이 존재하지 않음 (skip_resume=False인 경우)
        """
        # graceful_shutdown 특수 케이스: skip_resume=True
        # running 세션이면 본 플래그와 무관하게 큐잉(submit_message running 분기에 위임).
        # non-running(terminal/evicted/없음)이면 즉시 skipped 반환 — auto-resume 미수행.
        if skip_resume:
            task = self._tasks.get(agent_session_id)
            if not (task and task.status == TaskStatus.RUNNING):
                return {"skipped": True}
            # running이면 아래 submit_message 호출로 자연스럽게 떨어짐 (큐잉만 발생)

        # 일반 케이스 — submit_message 정본 호출
        # import는 함수 내부 — task_manager ↔ message_submission_service 순환 import 방지
        from soul_server.service.message_submission_service import (
            SubmitMessageParams,
            submit_message,
        )

        result = await submit_message(
            SubmitMessageParams(
                prompt=text,
                agent_session_id=agent_session_id,
                user=user,
                attachment_paths=attachment_paths,
                caller_info=caller_info,
                context_items=context_items,
                extra_context_items=extra_context_items,
            ),
            task_manager=self,
        )

        if result.kind == "intervened":
            return {"queue_position": result.queue_position}
        # auto_resumed (kind='new_session'은 agent_session_id가 항상 제공되므로 발생 불가지만 방어)
        return {
            "auto_resumed": True,
            "agent_session_id": result.agent_session_id,
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

    # === 백그라운드 실행 관리 → task_manager.executor 직접 사용 ===
    # (pass-through 제거됨: start_execution, is_execution_running, send_reconnect_status)

    # === 정리 ===

    async def cancel_running_tasks(self, timeout: float = 5.0) -> int:
        """실행 중인 모든 태스크 취소 (TaskMaintenance에 위임)."""
        return await self._task_maintenance.cancel_running_tasks(timeout)

    async def cleanup_orphaned_running(self, max_age_hours: int = 24) -> int:
        """고아 running 태스크 보정 (TaskMaintenance에 위임)."""
        return await self._task_maintenance.cleanup_orphaned_running(max_age_hours)

    async def get_stats(self) -> dict:
        """통계 반환 (TaskMaintenance에 위임)."""
        return await self._task_maintenance.get_stats()


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
