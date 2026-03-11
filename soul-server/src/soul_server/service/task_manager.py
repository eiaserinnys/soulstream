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
from datetime import timedelta
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
)
from soul_server.service.task_storage import TaskStorage
from soul_server.service.task_listener import TaskListenerManager
from soul_server.service.task_executor import TaskExecutor
from soul_server.service.event_store import EventStore
from soul_server.service.session_broadcaster import get_session_broadcaster

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
    ):
        """
        Args:
            storage_path: 태스크 저장 파일 경로 (None이면 영속화 안 함)
            event_store: 이벤트 영속화 저장소 (None이면 이벤트 저장하지 않음)
        """
        # 핵심 데이터 (key = agent_session_id)
        self._tasks: Dict[str, Task] = {}
        self._lock = asyncio.Lock()
        # claude_session_id → agent_session_id 역방향 인덱스
        self._session_index: Dict[str, str] = {}

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
        """파일에서 태스크 로드 (JSONL 이벤트 기반 상태 보정 포함)"""
        return await self._storage.load(self._tasks, event_store=self._event_store)

    async def save(self) -> None:
        """태스크 상태 저장"""
        await self._storage.save(self._tasks)

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
    ) -> tuple[List[Task], int]:
        """세션 목록 반환 (생성일 기준 내림차순, 페이지네이션 지원)

        Args:
            offset: 건너뛸 항목 수 (기본 0)
            limit: 반환할 최대 항목 수 (0이면 전체)
            session_type: 세션 타입 필터 ("claude" | "llm", None이면 전체)

        Returns:
            (세션 리스트, 전체 세션 수) 튜플
        """
        all_tasks = list(self._tasks.values())
        if session_type:
            all_tasks = [t for t in all_tasks if t.session_type == session_type]

        all_sorted = sorted(
            all_tasks,
            key=lambda t: t.created_at,
            reverse=True,
        )
        total = len(all_sorted)

        if offset > 0:
            all_sorted = all_sorted[offset:]
        if limit > 0:
            all_sorted = all_sorted[:limit]

        return all_sorted, total

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
        """세션 태스크 조회"""
        return self._tasks.get(agent_session_id)

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
        """모든 리스너에게 이벤트 브로드캐스트"""
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
        if not task:
            raise TaskNotFoundError(f"Session not found: {agent_session_id}")

        if task.status == TaskStatus.RUNNING:
            message = {
                "text": text,
                "user": user,
                "attachment_paths": attachment_paths or [],
            }
            await task.intervention_queue.put(message)
            return {"queue_position": task.intervention_queue.qsize()}

        # 완료/에러 → 자동 resume (같은 세션 재활성화)
        task = await self.create_task(
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
            "total": len(self._tasks),
            "running": running,
            "completed": completed,
            "error": error,
            "interrupted": interrupted,
        }


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
) -> TaskManager:
    """TaskManager 초기화"""
    global task_manager
    task_manager = TaskManager(storage_path=storage_path, event_store=event_store)
    return task_manager


def set_task_manager(manager: Optional[TaskManager]) -> None:
    """TaskManager 인스턴스 설정 (테스트용)"""
    global task_manager
    task_manager = manager
