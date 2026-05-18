"""
TaskFactory — 신규 세션 생성 + 기존 세션 재개의 단일 책임.

TaskManager에서 추출됨. _tasks/_lock/eviction_manager의 정본 소유자는
TaskManager에 남아 있고, factory는 참조를 주입받아 사용한다
(task_executor.py와 동일한 의존성 주입 패턴).
"""

import asyncio
import logging
from dataclasses import dataclass
from typing import Awaitable, Callable, Dict, List, Optional, Tuple, TYPE_CHECKING

if TYPE_CHECKING:
    from soul_server.service.agent_registry import AgentRegistry

from soul_server.service.task_models import (
    Task,
    TaskStatus,
    TaskConflictError,
    NodeMismatchError,
    generate_agent_session_id,
)
from soul_common.auth.caller_info import IDENTITY_BEARING_SOURCES, has_caller_identity
from soul_server.service.postgres_session_db import PostgresSessionDB
from soul_server.service.session_broadcaster import get_session_broadcaster
from soul_server.service.session_eviction_manager import SessionEvictionManager

logger = logging.getLogger(__name__)


# R-2 fix(2026-05-10): resume 시 빈 신원 caller_info(예: 인증 안 된 browser
# `{source: 'browser', ip: ...}`)가 이전의 정상 caller_info를 덮어쓰던 G-3 회로(atom 0d366900)를
# 닫는 정체성 가드. design-principles §3 정본 보존.
#
# R-4 fix(2026-05-11, atom G-13): IDENTITY_BEARING_SOURCES를 soul_common 정본으로 추출.
# 3 위치(task_factory + dashboard/user_profile + orch session_serializer)가 단일 import.
#
# R-6 fix(2026-05-11, atom G-20): 본 함수 자체를 `soul_common.auth.caller_info.has_caller_identity`로
# 추출 — `extract_caller_info_from_metadata`가 *마지막 신원 박힌 entry* 추출에 동일 로직을 사용해야
# §3 정본 하나로 합쳤다. 본 alias는 backward-compat을 위해 유지 — 같은 function reference라
# function identity check 통과 (R-5 plugin_sdk re-export 옵션 A 패턴 §9 대칭).
#
# 정체성 명시 source(IDENTITY_BEARING_SOURCES 7 원소)는 신원 필드가 비어도 True —
# enrichment 헬퍼의 NOOP 정책과 §9 대칭. 그 외 source는 신원 필드(display_name 또는 avatar_url)
# truthy일 때만 True.
_has_identity = has_caller_identity


@dataclass(frozen=True)
class CreateTaskParams:
    """create_task의 전 인자를 응집하는 불변 파라미터.

    필드 의미는 TaskManager.create_task의 docstring(원본 L583-610)을 따른다.
    """
    prompt: str
    agent_session_id: Optional[str] = None
    client_id: Optional[str] = None
    allowed_tools: Optional[List[str]] = None
    disallowed_tools: Optional[List[str]] = None
    use_mcp: bool = True
    context: Optional[dict] = None
    context_items: Optional[List[dict]] = None
    extra_context_items: Optional[List[dict]] = None
    model: Optional[str] = None
    folder_id: Optional[str] = None
    system_prompt: Optional[str] = None
    profile_id: Optional[str] = None
    oauth_token: Optional[str] = None
    caller_session_id: Optional[str] = None
    caller_info: Optional[dict] = None
    attachment_paths: Optional[List[str]] = None
    # skip_claude_resume=True면 기존 세션 재활성화 시 task.resume_session_id를 None으로 박는다.
    # ClaudeAgentOptions.resume이 설정되지 않아 Claude SDK가 fresh 세션으로 시작 — Claude 계정
    # limit 후 previous_message_id 400 회로 차단. submit_message의 terminal 분기에서 True로 설정.
    # 직접 create_task 호출(레거시)이나 신규 세션 경로는 영향 없음.
    skip_claude_resume: bool = False


# (agent_session_id, session_type, folder_id) -> assigned_folder_id
AssignDefaultFolderFn = Callable[[str, str, Optional[str]], Awaitable[Optional[str]]]


class TaskFactory:
    """새 Task 생성 또는 기존 세션 재개를 담당.

    TaskManager에서 _tasks/_lock/eviction_manager의 참조를 주입받아 사용한다
    (TaskExecutor와 동일한 패턴). _tasks의 정본 소유는 TaskManager.
    """

    def __init__(
        self,
        *,
        session_db: PostgresSessionDB,
        tasks: Dict[str, Task],
        lock: asyncio.Lock,
        eviction_manager: SessionEvictionManager,
        agent_registry: Optional["AgentRegistry"],
        assign_default_folder: AssignDefaultFolderFn,
    ):
        self._db = session_db
        self._tasks = tasks
        self._lock = lock
        self._eviction_manager = eviction_manager
        self._agent_registry = agent_registry
        self._assign_default_folder = assign_default_folder

    async def create_or_resume(self, params: CreateTaskParams) -> Tuple[Task, bool]:
        """params에 따라 신규 Task 생성 또는 기존 세션 재개.

        Returns: (task, is_new)
        Raises:
            ValueError: profile_id가 registry에 없는 경우
            TaskConflictError: agent_session_id 세션이 이미 RUNNING
            NodeMismatchError: 다른 노드 소속 세션의 resume 시도
        """
        # profile_id 유효성 검사 (TaskManager.create_task 원본 L613-615와 동일)
        if params.profile_id is not None and self._agent_registry is not None:
            if not self._agent_registry.has(params.profile_id):
                raise ValueError(
                    f"존재하지 않는 에이전트 프로필: {params.profile_id}"
                )

        merged = (params.context_items or []) + (params.extra_context_items or [])
        effective_context_items = merged or None

        is_resume = params.agent_session_id is not None
        agent_session_id = params.agent_session_id or generate_agent_session_id()

        async with self._lock:
            existing = self._tasks.get(agent_session_id)

            if not existing and is_resume:
                existing = await self._eviction_manager.load_evicted_task(
                    self._db, agent_session_id
                )
                if existing:
                    if (
                        existing.node_id is not None
                        and existing.node_id != self._db.node_id
                    ):
                        raise NodeMismatchError(
                            existing.node_id, self._db.node_id
                        )
                    self._tasks[agent_session_id] = existing
                    logger.info(
                        f"Restored evicted session for resume: {agent_session_id}"
                    )

            if existing:
                if existing.status == TaskStatus.RUNNING:
                    raise TaskConflictError(
                        f"Session already running: {agent_session_id}"
                    )
                await self._resume_existing_task_locked(
                    existing, params, effective_context_items
                )
                task = existing
                is_new = False
            else:
                task = self._create_new_task_locked(
                    agent_session_id, params, effective_context_items
                )
                is_new = True

        # === 락 외부 후속 처리 ===
        if is_new:
            await self._register_new_session_async(task, params.folder_id)
        else:
            await self._resume_task_unlocked(task, params.prompt, task.client_id)

        return task, is_new

    async def _resume_existing_task_locked(
        self,
        task: Task,
        params: CreateTaskParams,
        effective_context_items: Optional[List[dict]],
    ) -> None:
        """완료/에러 Task를 RUNNING으로 in-place 갱신. _lock 보유 상태에서 호출.

        원본: task_manager.py L504-561과 동일 동작.
        """
        resume_session_id = task.claude_session_id
        # skip_claude_resume=True (submit_message terminal 분기)이면 ClaudeAgentOptions.resume을
        # 박지 않아 Claude SDK가 fresh 세션으로 시작한다. agent_session_id 묶음은 유지되지만
        # Claude SDK 차원의 conversation 이력은 손실 — limit 후 previous_message_id 400 회로
        # (코덱스 진단 atom 0fa49771) 차단을 위한 정책. 폴더 프롬프트/atom 트리는
        # execution_context_builder._resolve_folder L100 분기로 재주입된다.
        effective_resume_session_id = (
            None if params.skip_claude_resume else resume_session_id
        )
        logger.info(
            f"Resuming session: {task.agent_session_id} "
            f"(claude_session={resume_session_id}, skip_claude_resume={params.skip_claude_resume})"
        )

        # NOTE: 원본도 lock 내에서 await — 동일 의미 보존.
        db_session = await self._db.get_session(task.agent_session_id)
        if db_session and db_session.get("metadata"):
            task.metadata = db_session["metadata"]

        task.prompt = params.prompt
        task.status = TaskStatus.RUNNING
        task.resume_session_id = effective_resume_session_id
        task.result = None
        task.error = None
        task.completed_at = None
        task.last_progress_text = None
        task.intervention_queue = asyncio.Queue()
        task.allowed_tools = params.allowed_tools
        task.disallowed_tools = params.disallowed_tools
        task.use_mcp = params.use_mcp
        task.context = params.context
        task.context_items = effective_context_items
        task.attachment_paths = params.attachment_paths
        task.model = params.model
        task.system_prompt = params.system_prompt
        if params.profile_id is not None:
            task.profile_id = params.profile_id
        if params.oauth_token is not None:
            task.oauth_token = params.oauth_token
        if params.client_id:
            task.client_id = params.client_id
        # F-9 fix(2026-05-08): resume 시 새 caller_info를 task.caller_info에 갱신.
        # task_executor._persist_initial_messages가 task.caller_info를 user_message
        # wire에 첨부하므로, 갱신하지 않으면 2차+ 메시지가 첫 메시지의 caller_info를
        # (in-memory 보존 시) 또는 None을 (eviction-reload 시) 사용해 결함 발생.
        # params.caller_info가 None이면 기존 task.caller_info 보존 (graceful — 외부
        # 호출자가 명시적으로 의도 표명한 경우만 덮어씀).
        # R-2 fix(2026-05-10): 빈 신원 dict(예: 인증 안 된 browser `{source: 'browser', ip: ...}`)가
        # 이전의 정상 caller_info를 덮어쓰지 않는다. _has_identity가 정체성 명시 source 또는
        # display_name/avatar_url truthy일 때만 갱신 (atom 0d366900, §3).
        # R-6 fix(2026-05-11, atom G-20): task.caller_info 갱신과 *함께* DB metadata에도 entry
        # append — append-only history ledger 패턴. `_register_new_session_async`(L289-291)와
        # §9 대칭. 인메모리만 갱신하던 이전 동작은 REST 응답(DB-derived)과 SSE wire(in-memory-derived)
        # 시간 축 비대칭 회로(sess-20260419114049-8cf09982 라이브 재현)의 근본 원인.
        # `extract_caller_info_from_metadata`(soul_common.auth.caller_info)가 *마지막 신원 박힌
        # entry* 우선 반환으로 갱신되어 본 append가 현재 caller로 즉시 인식된다.
        if params.caller_info is not None and _has_identity(params.caller_info):
            task.caller_info = params.caller_info
            entry = {"type": "caller_info", "value": params.caller_info}
            task.metadata.append(entry)
            await self._db.append_metadata(task.agent_session_id, entry)

        self._eviction_manager.unregister(task.agent_session_id)

    def _create_new_task_locked(
        self,
        agent_session_id: str,
        params: CreateTaskParams,
        effective_context_items: Optional[List[dict]],
    ) -> Task:
        """신규 Task 생성 + _tasks 등록. _lock 보유 상태에서 호출.

        원본: task_manager.py L688-727과 동일 동작.
        """
        task = Task(
            agent_session_id=agent_session_id,
            prompt=params.prompt,
            client_id=params.client_id,
            allowed_tools=params.allowed_tools,
            disallowed_tools=params.disallowed_tools,
            use_mcp=params.use_mcp,
            context=params.context,
            context_items=effective_context_items,
            model=params.model,
            system_prompt=params.system_prompt,
            profile_id=params.profile_id,
            oauth_token=params.oauth_token,
            caller_session_id=params.caller_session_id,
            caller_info=params.caller_info,
        )
        task.attachment_paths = params.attachment_paths
        self._tasks[agent_session_id] = task
        logger.info(f"Created new session: {agent_session_id}")
        return task

    async def _register_new_session_async(
        self,
        task: Task,
        folder_id: Optional[str],
    ) -> None:
        """신규 세션의 락 외부 후속 처리.

        원본: task_manager.py L729-774와 동일 동작.
        node_id → DB pending INSERT → caller_info metadata → 폴더 배정 → session_created 발행.
        """
        agent_session_id = task.agent_session_id
        task.node_id = self._db.node_id
        await self._db.register_session_initial(
            session_id=agent_session_id,
            node_id=self._db.node_id,
            agent_id=task.profile_id,
            claude_session_id=None,
            session_type=task.session_type,
            prompt=task.prompt,
            client_id=task.client_id,
            status=TaskStatus.RUNNING.value,
            created_at=task.created_at,
            caller_session_id=task.caller_session_id,
        )
        # caller_info를 Task.metadata와 DB에 동시 저장 (신규 세션에만 — resume 시 무시)
        # session_created 이벤트 전 타이밍 — append_session_metadata 사용 시
        # metadata_updated/session_updated가 session_created보다 먼저 발행되어 클라이언트 혼동.
        if task.caller_info:
            entry = {"type": "caller_info", "value": task.caller_info}
            task.metadata.append(entry)
            await self._db.append_metadata(agent_session_id, entry)

        # 폴더 배정 + catalog_updated 브로드캐스트 — TaskManager 메서드에 위임
        assigned_folder_id = await self._assign_default_folder(
            agent_session_id,
            task.session_type,
            folder_id,
        )
        # catalog_updated 이후 session_created 발행 (순서 보장 — 부가 기능)
        try:
            await get_session_broadcaster().emit_session_created(
                task, folder_id=assigned_folder_id
            )
        except Exception:
            logger.warning(
                f"Failed to emit session_created for {agent_session_id}",
                exc_info=True,
            )

    async def _resume_task_unlocked(
        self,
        task: Task,
        prompt: str,
        client_id: Optional[str],
    ) -> None:
        """재개 세션의 락 외부 후속 처리.

        원본: task_manager.py L776-798과 동일 동작.
        """
        agent_session_id = task.agent_session_id
        await self._db.update_session(
            agent_session_id,
            status=TaskStatus.RUNNING.value,
            prompt=prompt,
            client_id=client_id,
        )
        try:
            await get_session_broadcaster().emit_session_updated(task)
        except Exception:
            logger.warning(
                f"Failed to broadcast session update for {agent_session_id}",
                exc_info=True,
            )
