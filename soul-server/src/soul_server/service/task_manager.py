"""
TaskManager - 세션 라이프사이클 관리

세션(agent_session_id) 기반 아키텍처의 핵심 컴포넌트.
클라이언트의 실행 요청을 세션 단위로 관리하고,
결과를 영속화하여 클라이언트 재시작 시에도 복구 가능하게 합니다.

이 모듈은 다음 서브모듈들을 조합합니다:
- task_models: 데이터 모델 및 예외
- task_storage: JSON 영속화
- task_listener: SSE 리스너 관리
- task_executor: 백그라운드 실행
"""

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, Dict, List

from soul_server.service.task_models import (
    Task,
    TaskStatus,
    TaskConflictError,
    TaskNotFoundError,
    TaskNotRunningError,
    generate_agent_session_id,
    utc_now,
    datetime_to_str,
    str_to_datetime,
)
from soul_server.service.task_storage import TaskStorage, recover_orphan_sessions
from soul_server.service.task_listener import TaskListenerManager
from soul_server.service.task_executor import TaskExecutor
from soul_server.service.event_store import EventStore
from soul_server.service.session_catalog import SessionCatalog
from soul_server.service.session_broadcaster import get_session_broadcaster

# 이벤트 타입별 미리보기 텍스트 필드 매핑
PREVIEW_FIELD_MAP = {
    "user_message": "text",
    "intervention": "text",
    "thinking": "thinking",
    "result": "result",
    "complete": "result",
    "error": "error",
}

# Re-export for backward compatibility
__all__ = [
    "Task",
    "TaskStatus",
    "TaskConflictError",
    "TaskNotFoundError",
    "TaskNotRunningError",
    "TaskManager",
    "task_manager",
    "get_task_manager",
    "init_task_manager",
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
        storage_path: Optional[Path] = None,
        event_store: Optional[EventStore] = None,
        eviction_ttl: int = 900,
    ):
        """
        Args:
            storage_path: 태스크 저장 파일 경로 (None이면 영속화 안 함)
            event_store: 이벤트 영속화 저장소 (None이면 이벤트 저장하지 않음)
            eviction_ttl: 완료 세션 메모리 퇴거 TTL (초, 기본 15분)
        """
        # 핵심 데이터 (key = agent_session_id)
        self._tasks: Dict[str, Task] = {}
        self._lock = asyncio.Lock()
        # claude_session_id → agent_session_id 역방향 인덱스
        self._session_index: Dict[str, str] = {}

        # 세션 카탈로그 (모든 세션의 경량 인덱스)
        catalog_path = (
            storage_path.parent / "session_catalog.json" if storage_path else None
        )
        self._catalog = SessionCatalog(catalog_path)

        # LRU 퇴거 관리
        self._eviction_ttl = eviction_ttl
        self._eviction_candidates: Dict[str, float] = {}  # {session_id: expiry_timestamp}
        self._eviction_task: Optional[asyncio.Task] = None

        # 서브 컴포넌트들
        self._storage = TaskStorage(storage_path)
        self._listener_manager = TaskListenerManager(self._tasks)
        self._event_store = event_store
        self._executor = TaskExecutor(
            tasks=self._tasks,
            listener_manager=self._listener_manager,
            get_intervention_func=self.get_intervention,
            complete_task_func=self._complete_task_internal,
            error_task_func=self._error_task_internal,
            register_session_func=self.register_session,
            event_store=event_store,
        )

    # === Public Properties ===

    @property
    def event_store(self) -> Optional[EventStore]:
        """이벤트 저장소 접근자"""
        return self._event_store

    # === claude_session_id 인덱스 ===

    def register_session(self, claude_session_id: str, agent_session_id: str) -> None:
        """claude_session_id → agent_session_id 매핑 등록

        SoulEngineAdapter가 session 이벤트를 발행할 때 호출합니다.
        """
        self._session_index[claude_session_id] = agent_session_id
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
        """파일에서 태스크 로드 (JSONL 이벤트 기반 상태 보정 포함)

        기존 카탈로그를 로드한 뒤 tasks.json의 세션만 upsert하고,
        JSONL/카탈로그 수 불일치 시에만 고아 세션을 복구합니다.
        비실행 세션은 메모리에서 즉시 퇴거합니다.
        """
        # 1. tasks.json 로드 + 상태 보정 (고아 복구는 여기서 하지 않음)
        loaded = await self._storage.load(self._tasks, event_store=self._event_store)

        # 2. 기존 카탈로그 파일 로드
        await self._catalog.load()

        # 3. tasks.json의 세션만 카탈로그에 반영 (기존 엔트리 유지)
        for session_id, task in self._tasks.items():
            self._catalog.upsert_from_task(task)

        # 4. 고아 세션 복구: JSONL/카탈로그 집합 불일치 시에만 실행
        orphans_recovered = 0
        if self._event_store:
            jsonl_ids = set(self._event_store.list_session_ids())
            catalog_ids = self._catalog.known_session_ids()
            if jsonl_ids != catalog_ids:
                logger.info(
                    f"JSONL/catalog mismatch: "
                    f"JSONL-only={len(jsonl_ids - catalog_ids)}, "
                    f"catalog-only={len(catalog_ids - jsonl_ids)}, recovering..."
                )
                orphans_recovered = recover_orphan_sessions(
                    self._tasks, self._event_store, catalog=self._catalog
                )
                if orphans_recovered:
                    loaded += orphans_recovered
                    await self._storage.save(self._tasks)
            else:
                logger.info(
                    f"Catalog matches JSONL ({len(catalog_ids)} sessions), "
                    f"skipping orphan recovery"
                )

        # 5. 비실행 세션을 _tasks에서 완전 퇴거 (서버 기동 시에는 LRU 없이 즉시)
        evicted_ids = [
            sid for sid, task in self._tasks.items()
            if task.status != TaskStatus.RUNNING
        ]
        for sid in evicted_ids:
            del self._tasks[sid]
            self._unregister_claude_session(sid)

        if evicted_ids:
            logger.info(f"Startup eviction: {len(evicted_ids)} non-running sessions removed from memory")

        # 6. 퇴거 루프 시작
        self._eviction_task = asyncio.create_task(self._eviction_loop())

        return loaded

    async def save(self) -> None:
        """태스크 상태 저장

        영속화 전략:
        - tasks.json: 현재 메모리의 working set만 저장 (running 세션 + LRU 캐시)
        - session_catalog.json: 전체 세션 인덱스 (퇴거된 세션 포함, 정본)

        session_catalog.json이 정본이며, tasks.json 손실 시에도
        카탈로그에서 모든 세션 메타데이터를 복원할 수 있습니다.
        """
        await self._storage.save(self._tasks)
        await self._catalog.save_now()

    async def _schedule_save(self) -> None:
        """저장 예약 (debounce)"""
        await self._storage.schedule_save(self._tasks)

    # === CRUD 작업 ===

    async def register_external_task(self, task: Task) -> None:
        """외부에서 생성된 태스크를 등록한다.

        LLM 프록시 등 TaskManager의 create_task 흐름을 거치지 않는
        외부 모듈이 직접 생성한 Task를 등록할 때 사용합니다.

        Args:
            task: 등록할 Task 인스턴스
        """
        async with self._lock:
            self._tasks[task.agent_session_id] = task
        self._catalog.upsert_from_task(task)
        await self._schedule_save()

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
        """
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

        # 카탈로그 업데이트 + LRU 퇴거 후보 등록
        self._catalog.upsert(
            agent_session_id,
            status=task.status.value,
            completed_at=datetime_to_str(task.completed_at),
        )
        self._eviction_candidates[agent_session_id] = time.time() + self._eviction_ttl

        await self._schedule_save()
        try:
            await get_session_broadcaster().emit_session_updated(task)
        except Exception:
            logger.warning(f"Failed to broadcast finalize for {agent_session_id}", exc_info=True)
        return task

    def get_running_tasks(self) -> List[Task]:
        """실행 중인 태스크 목록 반환"""
        return [t for t in self._tasks.values() if t.status == TaskStatus.RUNNING]

    def get_all_sessions(
        self,
        offset: int = 0,
        limit: int = 0,
        session_type: Optional[str] = None,
    ) -> tuple[list[dict], int]:
        """세션 목록 반환 (생성일 기준 내림차순, 페이지네이션 + 타입 필터 지원)

        카탈로그 기반으로 전체 세션 목록을 반환합니다.
        running 세션의 pid는 _tasks에서 보충합니다.

        Args:
            offset: 건너뛸 항목 수 (기본 0)
            limit: 반환할 최대 항목 수 (0이면 전체)
            session_type: 세션 타입 필터 ("claude" | "llm", None이면 전체)

        Returns:
            (세션 dict 리스트, 전체 세션 수) 튜플
        """
        # session_type 필터링을 위해 전체를 먼저 가져온 뒤 필터 → 페이지네이션
        all_entries, _ = self._catalog.get_all(offset=0, limit=0)

        if session_type:
            all_entries = [
                e for e in all_entries
                if e.get("session_type", "claude") == session_type
            ]

        total = len(all_entries)

        if offset > 0:
            all_entries = all_entries[offset:]
        if limit > 0:
            all_entries = all_entries[:limit]

        result = []
        for entry in all_entries:
            session_id = entry["agent_session_id"]
            # running 세션의 pid를 _tasks에서 보충
            pid = entry.get("pid")
            task = self._tasks.get(session_id)
            if task:
                pid = task.pid
            created_at = entry.get("created_at", "")
            result.append({
                "agent_session_id": session_id,
                "status": entry.get("status", "unknown"),
                "prompt": entry.get("prompt", ""),
                "created_at": created_at,
                "updated_at": entry.get("completed_at") or created_at,
                "pid": pid,
                "session_type": entry.get("session_type", "claude"),
                "last_message": entry.get("last_message"),
            })
        return result, total

    async def create_task(
        self,
        prompt: str,
        agent_session_id: Optional[str] = None,
        client_id: Optional[str] = None,
        allowed_tools: Optional[List[str]] = None,
        disallowed_tools: Optional[List[str]] = None,
        use_mcp: bool = True,
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

        Returns:
            Task: 생성되거나 재활성화된 태스크

        Raises:
            TaskConflictError: 해당 세션에 이미 running 태스크가 존재
        """
        is_resume = agent_session_id is not None

        if not is_resume:
            agent_session_id = generate_agent_session_id()

        async with self._lock:
            existing = self._tasks.get(agent_session_id)

            # 퇴거된 세션의 resume 지원: _tasks에 없으면 카탈로그/저장소에서 복원
            if not existing and is_resume:
                existing = await self._load_evicted_task(agent_session_id)
                if existing:
                    self._tasks[agent_session_id] = existing
                    logger.info(f"Restored evicted session for resume: {agent_session_id}")

            if existing:
                if existing.status == TaskStatus.RUNNING:
                    raise TaskConflictError(f"Session already running: {agent_session_id}")

                # 완료/에러 세션 → resume
                resume_session_id = existing.claude_session_id
                logger.info(f"Resuming session: {agent_session_id} (claude_session={resume_session_id})")

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
                if client_id:
                    existing.client_id = client_id

                # 퇴거 후보에서 제거
                self._eviction_candidates.pop(agent_session_id, None)

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
                )
                self._tasks[agent_session_id] = task
                logger.info(f"Created new session: {agent_session_id}")
                is_new = True

        # 카탈로그에 세션 등록/업데이트
        existing_entry = self._catalog.get(agent_session_id)
        self._catalog.upsert(
            agent_session_id,
            status=TaskStatus.RUNNING.value,
            prompt=prompt,
            session_type=task.session_type,
            client_id=task.client_id,
            claude_session_id=task.claude_session_id,
            created_at=datetime_to_str(task.created_at),
            completed_at=None,
            pid=None,
            last_message=existing_entry.get("last_message") if existing_entry else None,
        )

        await self._schedule_save()

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
        2. _eviction_candidates에 있으면 LRU TTL 갱신
        3. _tasks에 없으면 저장소에서 on-demand 로드 (메모리에 상주시키지 않음)
        """
        task = self._tasks.get(agent_session_id)
        if task:
            # LRU 캐시 히트 → TTL 갱신
            if agent_session_id in self._eviction_candidates:
                self._eviction_candidates[agent_session_id] = (
                    time.time() + self._eviction_ttl
                )
            return task

        # on-demand 로드 (퇴거된 세션)
        return await self._load_evicted_task(agent_session_id)

    async def _complete_task_internal(
        self,
        agent_session_id: str,
        result: str,
        claude_session_id: Optional[str] = None,
    ) -> Optional[Task]:
        """태스크 완료 처리 (내부용 - executor에서 호출)"""
        return await self.complete_task(agent_session_id, result, claude_session_id)

    async def complete_task(
        self,
        agent_session_id: str,
        result: str,
        claude_session_id: Optional[str] = None,
    ) -> Optional[Task]:
        """
        세션 태스크 완료 처리

        Args:
            agent_session_id: 세션 식별자
            result: 실행 결과
            claude_session_id: Claude Code 세션 ID (다음 resume에 사용)

        Returns:
            업데이트된 태스크 (없으면 None)
        """
        async with self._lock:
            task = self._tasks.get(agent_session_id)
            if not task:
                logger.warning(f"Task not found for complete: {agent_session_id}")
                return None

            task.status = TaskStatus.COMPLETED
            task.result = result
            task.claude_session_id = claude_session_id
            task.completed_at = utc_now()

            logger.info(f"Completed session: {agent_session_id}")

        # 카탈로그 업데이트 + LRU 퇴거 후보 등록
        self._catalog.upsert(
            agent_session_id,
            status=TaskStatus.COMPLETED.value,
            claude_session_id=claude_session_id,
            completed_at=datetime_to_str(task.completed_at),
        )
        self._eviction_candidates[agent_session_id] = time.time() + self._eviction_ttl
        self._unregister_claude_session(agent_session_id)

        await self._schedule_save()
        try:
            await get_session_broadcaster().emit_session_updated(task)
        except Exception:
            logger.warning(f"Failed to broadcast completion for {agent_session_id}", exc_info=True)
        return task

    async def _error_task_internal(
        self,
        agent_session_id: str,
        error: str,
    ) -> Optional[Task]:
        """태스크 에러 처리 (내부용 - executor에서 호출)"""
        return await self.error_task(agent_session_id, error)

    async def error_task(
        self,
        agent_session_id: str,
        error: str,
    ) -> Optional[Task]:
        """
        세션 태스크 에러 처리

        Args:
            agent_session_id: 세션 식별자
            error: 에러 메시지

        Returns:
            업데이트된 태스크 (없으면 None)
        """
        async with self._lock:
            task = self._tasks.get(agent_session_id)
            if not task:
                logger.warning(f"Task not found for error: {agent_session_id}")
                return None

            task.status = TaskStatus.ERROR
            task.error = error
            task.completed_at = utc_now()

            logger.info(f"Error session: {agent_session_id} - {error}")

        # 카탈로그 업데이트 + LRU 퇴거 후보 등록
        self._catalog.upsert(
            agent_session_id,
            status=TaskStatus.ERROR.value,
            completed_at=datetime_to_str(task.completed_at),
        )
        self._eviction_candidates[agent_session_id] = time.time() + self._eviction_ttl
        self._unregister_claude_session(agent_session_id)

        await self._schedule_save()
        try:
            await get_session_broadcaster().emit_session_updated(task)
        except Exception:
            logger.warning(f"Failed to broadcast error for {agent_session_id}", exc_info=True)
        return task

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
        """모든 리스너에게 이벤트 브로드캐스트

        PREVIEW_FIELD_MAP에 해당하는 이벤트 타입이면 카탈로그의
        last_message를 업데이트합니다.
        """
        # 카탈로그 last_message 업데이트
        event_type = event.get("type", "")
        text_field = PREVIEW_FIELD_MAP.get(event_type)
        if text_field:
            text = event.get(text_field, "")
            if isinstance(text, str) and text:
                ts = event.get("timestamp")
                if isinstance(ts, (int, float)):
                    ts_str = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
                elif isinstance(ts, str):
                    ts_str = ts
                else:
                    ts_str = datetime_to_str(utc_now())
                self._catalog.update_last_message(
                    agent_session_id, event_type, text[:200], ts_str
                )

        return await self._listener_manager.broadcast(agent_session_id, event)

    # === 개입 메시지 관리 ===

    async def add_intervention(
        self,
        agent_session_id: str,
        text: str,
        user: str,
        attachment_paths: Optional[List[str]] = None,
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

        Returns:
            결과 딕셔너리:
            - running: {"queue_position": int}
            - 자동 resume: {"auto_resumed": True, "agent_session_id": str}

        Raises:
            TaskNotFoundError: 세션이 존재하지 않음
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

        if not task:
            # 퇴거된 세션 on-demand 로드
            task = await self._load_evicted_task(agent_session_id)
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
        if self._eviction_task:
            self._eviction_task.cancel()
            try:
                await self._eviction_task
            except asyncio.CancelledError:
                pass
            self._eviction_task = None

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
            # 카탈로그 업데이트 + 퇴거 후보 등록
            for task in fixed_tasks:
                self._catalog.upsert(
                    task.agent_session_id,
                    status=TaskStatus.INTERRUPTED.value,
                    completed_at=datetime_to_str(task.completed_at),
                )
                self._eviction_candidates[task.agent_session_id] = (
                    time.time() + self._eviction_ttl
                )
            await self._schedule_save()
            try:
                broadcaster = get_session_broadcaster()
                for task in fixed_tasks:
                    await broadcaster.emit_session_updated(task)
            except Exception:
                logger.warning("Failed to broadcast orphaned session fixes", exc_info=True)

        return fixed

    def _clear_queue(self, queue: asyncio.Queue) -> None:
        """큐 내 모든 항목 제거"""
        try:
            while True:
                queue.get_nowait()
        except asyncio.QueueEmpty:
            pass

    def get_stats(self) -> dict:
        """통계 반환"""
        running = sum(1 for t in self._tasks.values() if t.status == TaskStatus.RUNNING)
        completed = sum(1 for t in self._tasks.values() if t.status == TaskStatus.COMPLETED)
        error = sum(1 for t in self._tasks.values() if t.status == TaskStatus.ERROR)
        interrupted = sum(1 for t in self._tasks.values() if t.status == TaskStatus.INTERRUPTED)

        return {
            "total_in_memory": len(self._tasks),
            "total_in_catalog": len(self._catalog),
            "running": running,
            "completed": completed,
            "error": error,
            "interrupted": interrupted,
            "eviction_candidates": len(self._eviction_candidates),
        }

    # === LRU 퇴거 관리 ===

    async def _eviction_loop(self) -> None:
        """주기적 퇴거 루프 (60초 간격)"""
        while True:
            try:
                await asyncio.sleep(60)
                evicted = self._run_eviction_check()
                if evicted > 0:
                    logger.info(f"Eviction loop: removed {evicted} sessions from memory")
                    await self._schedule_save()
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

    async def _load_evicted_task(self, agent_session_id: str) -> Optional[Task]:
        """퇴거된 세션을 카탈로그에서 온디맨드 로드 (메모리에 상주시키지 않음)

        Args:
            agent_session_id: 세션 식별자

        Returns:
            복원된 Task 또는 None
        """
        entry = self._catalog.get(agent_session_id)
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
            return Task(
                agent_session_id=agent_session_id,
                prompt=entry.get("prompt", ""),
                status=TaskStatus(status_str),
                client_id=entry.get("client_id"),
                claude_session_id=entry.get("claude_session_id"),
                session_type=entry.get("session_type", "claude"),
                llm_provider=entry.get("llm_provider"),
                llm_model=entry.get("llm_model"),
                created_at=str_to_datetime(created_at_str),
                completed_at=(
                    str_to_datetime(entry["completed_at"])
                    if entry.get("completed_at")
                    else None
                ),
            )
        except (ValueError, KeyError) as e:
            logger.error(f"Failed to restore task from catalog: {agent_session_id}: {e}")
            return None


# 싱글톤 인스턴스는 main.py에서 초기화
task_manager: Optional[TaskManager] = None


def get_task_manager() -> TaskManager:
    """TaskManager 싱글톤 반환"""
    global task_manager
    if task_manager is None:
        raise RuntimeError("TaskManager not initialized. Call init_task_manager first.")
    return task_manager


def init_task_manager(
    storage_path: Optional[Path] = None,
    event_store: Optional[EventStore] = None,
    eviction_ttl: int = 900,
) -> TaskManager:
    """TaskManager 초기화"""
    global task_manager
    task_manager = TaskManager(
        storage_path=storage_path,
        event_store=event_store,
        eviction_ttl=eviction_ttl,
    )
    return task_manager


def set_task_manager(manager: Optional[TaskManager]) -> None:
    """TaskManager 인스턴스 설정 (테스트용)"""
    global task_manager
    task_manager = manager
