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
from soul_server.service.session_query_service import init_session_query_service
from soul_server.service.task_factory import CreateTaskParams, TaskFactory
from soul_server.util.attachment_helpers import build_attachment_context_items

# Re-export for backward compatibility
__all__ = [
    "Task",
    "TaskStatus",
    "TaskConflictError",
    "TaskNotFoundError",
    "TaskNotRunningError",
    "NodeMismatchError",
    "TaskManager",
    "CreateTaskParams",
    "task_manager",
    "get_task_manager",
    "set_task_manager",
    "utc_now",
    "generate_agent_session_id",
]

logger = logging.getLogger(__name__)


async def _relay_cross_node_intervention(
    caller_session_id: str, text: str
) -> None:
    """로컬 알림 실패 시 upstream을 통해 cross-node 인터벤션을 시도한다."""
    try:
        from soul_server.config import get_settings
        import re
        import httpx

        settings = get_settings()
        upstream_url = getattr(settings, "soulstream_upstream_url", None)
        if not upstream_url:
            return

        http_url = re.sub(r"^wss://", "https://", upstream_url)
        http_url = re.sub(r"^ws://", "http://", http_url)
        http_url = re.sub(r"/ws/.*$", "", http_url)

        auth_token = getattr(settings, "auth_bearer_token", "")
        headers = {"Authorization": f"Bearer {auth_token}"} if auth_token else {}

        async with httpx.AsyncClient(timeout=10.0, headers=headers) as client:
            resp = await client.post(
                f"{http_url}/api/sessions/{caller_session_id}/intervene",
                json={"text": text, "user": "agent"},
            )
            resp.raise_for_status()
        logger.info(
            f"Cross-node notification sent to {caller_session_id} via upstream"
        )
    except Exception as remote_err:
        logger.error(
            f"Cross-node notification failed for {caller_session_id}: {remote_err}"
        )


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
                agent_session_id, caller_session_id_to_notify, task_result, task_error
            )

        return task

    async def _notify_caller_completion(
        self,
        agent_session_id: str,
        caller_session_id: str,
        result_text: Optional[str],
        error_text: Optional[str],
    ) -> None:
        """완료된 세션의 결과를 caller 세션에 인터벤션으로 통지한다.

        caller 세션이 이미 완료 상태이면 auto-resume하고 실행을 시작한다.
        로컬 통지 실패 시 cross-node 릴레이를 시도한다.

        finalize_task()의 락 블록 바깥에서 호출되어야 한다
        (add_intervention이 동일 락을 획득하므로).
        """
        if result_text:
            notify_text = f"✅ 에이전트 세션 완료 (ID: `{agent_session_id}`)\n\n{result_text}"
        else:
            notify_text = f"❌ 에이전트 세션 오류 (ID: `{agent_session_id}`)\n\n{error_text or ''}"

        try:
            intervention_result = await self.add_intervention(
                agent_session_id=caller_session_id,
                text=notify_text,
                user="agent",
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
            await _relay_cross_node_intervention(caller_session_id, notify_text)

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
            # 방어 코드: startup에서 처리 누락되거나 레이스컨디션으로 RUNNING 상태가
            # 남아있을 경우 INTERRUPTED로 강제 전환하여 재개 가능하게 함
            if task.status == TaskStatus.RUNNING:
                logger.warning(
                    f"Evicted task has RUNNING status: {agent_session_id}. "
                    "Forcing to INTERRUPTED for safe resume."
                )
                task.status = TaskStatus.INTERRUPTED
                await self._db.update_session_status(
                    agent_session_id, TaskStatus.INTERRUPTED.value
                )

        # 완료/에러/중단 → 자동 resume (같은 세션 재활성화)
        extra_ctx = build_attachment_context_items(attachment_paths)

        await self.create_task(CreateTaskParams(
            prompt=text,
            agent_session_id=agent_session_id,
            client_id=user,
            extra_context_items=extra_ctx,
            attachment_paths=attachment_paths,
        ))

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

    # === 백그라운드 실행 관리 → task_manager.executor 직접 사용 ===
    # (pass-through 제거됨: start_execution, is_execution_running, send_reconnect_status)

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
