"""
Task Executor - 백그라운드 태스크 실행 관리

세션(agent_session_id) 단위로 Claude Code 실행을 백그라운드에서 관리합니다.
"""

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from typing import Dict, Callable, Awaitable, Optional, TYPE_CHECKING

from soul_server.service.task_models import Task, TaskStatus
from soul_server.service.session_broadcaster import get_session_broadcaster
from soul_server.service.context_builder import build_soulstream_context_item
from soul_server.service.event_persistence import EventPersistence
from soul_server.service.execution_context_builder import (
    ExecutionContextBuilder,
    _PreparedContext,
)

if TYPE_CHECKING:
    from soul_server.service.postgres_session_db import PostgresSessionDB
    from soul_server.service.task_listener import TaskListenerManager
    from soul_server.service.metadata_extractor import MetadataExtractor
    from soul_server.service.agent_registry import AgentRegistry

logger = logging.getLogger(__name__)


class TaskExecutor:
    """
    백그라운드 태스크 실행 관리자

    Claude Code 실행을 백그라운드에서 관리하고,
    실행 결과를 리스너에게 브로드캐스트합니다.
    이벤트는 EventStore에 영속화되어 재연결 시 재생할 수 있습니다.
    """

    def __init__(
        self,
        tasks: Dict[str, Task],
        listener_manager: "TaskListenerManager",
        get_intervention_func: Callable[[str], Awaitable[Optional[dict]]],
        finalize_task_func: Callable[..., Awaitable[Optional[Task]]],
        register_session_func: Optional[Callable[..., Awaitable[None]]] = None,
        session_db: Optional["PostgresSessionDB"] = None,
        metadata_extractor: Optional["MetadataExtractor"] = None,
        append_metadata_func: Optional[Callable] = None,
        agent_registry: Optional["AgentRegistry"] = None,
    ):
        """
        Args:
            tasks: TaskManager의 태스크 딕셔너리 참조 (key = agent_session_id)
            listener_manager: 리스너 매니저
            get_intervention_func: 개입 메시지 가져오기 함수 (agent_session_id) -> dict?
            finalize_task_func: 태스크 완료/에러 처리 함수 (agent_session_id, *, result=None, claude_session_id=None, error=None)
            register_session_func: claude_session_id 등록 함수 (claude_session_id, agent_session_id)
            session_db: PostgreSQL 기반 세션 저장소
            metadata_extractor: 메타데이터 추출기 (tool_result에서 자동 감지)
            append_metadata_func: 메타데이터 추가 함수 (agent_session_id, entry)
            agent_registry: AgentRegistry 인스턴스 (profile_id → 실행 옵션 조회용)
        """
        self._tasks = tasks
        self._listener_manager = listener_manager
        self._get_intervention = get_intervention_func
        self._finalize_task = finalize_task_func
        self._register_session = register_session_func
        self._db = session_db
        self._persistence = EventPersistence(
            session_db, metadata_extractor, append_metadata_func,
            get_broadcaster=lambda: get_session_broadcaster(),
        )
        self._registry = agent_registry
        self._context_builder = ExecutionContextBuilder(
            session_db=session_db,
            agent_registry=agent_registry,
        )

    async def start_execution(
        self,
        agent_session_id: str,
        claude_runner,
        resource_manager,
    ) -> bool:
        """
        세션의 Claude 실행을 백그라운드에서 시작

        SSE 연결과 독립적으로 실행되어, 클라이언트 재연결 시에도
        실행이 계속됩니다.

        Args:
            agent_session_id: 세션 식별자
            claude_runner: SoulEngineAdapter 인스턴스
            resource_manager: ResourceManager 인스턴스

        Returns:
            bool: 성공 여부
        """
        task = self._tasks.get(agent_session_id)
        if not task:
            logger.warning(f"Task not found for execution: {agent_session_id}")
            return False

        if task.execution_task is not None:
            logger.warning(f"Task already executing: {agent_session_id}")
            return False

        task.execution_task = asyncio.create_task(
            self._run_execution(
                task=task,
                claude_runner=claude_runner,
                resource_manager=resource_manager,
            )
        )
        logger.info(f"Started background execution for session: {agent_session_id}")

        return True

    async def _persist_initial_messages(
        self,
        task: Task,
        ctx: _PreparedContext,
    ) -> Optional[int]:
        """system_message와 user_message를 영속화하고 브로드캐스트한다.

        Returns:
            current_user_request_id: user_message의 event_id (parent_event_id 채움용, int)
        """
        session_id = task.agent_session_id
        current_user_request_id: Optional[int] = None

        # system_message 기록
        if self._db is not None and ctx.effective_system_prompt:
            try:
                sys_msg_event = {
                    "type": "system_message",
                    "text": ctx.effective_system_prompt,
                }
                event_id = await self._persistence.persist_event(session_id, sys_msg_event)
                sys_msg_event["_event_id"] = event_id
                if event_id is not None:
                    task.last_event_id = event_id
                await self._listener_manager.broadcast(session_id, sys_msg_event)
            except Exception as e:
                logger.warning(f"Failed to persist system_message for {session_id}: {e}")

        # user_message 기록
        if self._db is not None:
            try:
                user_msg_event = {
                    "type": "user_message",
                    "user": task.client_id or "unknown",
                    "text": task.prompt,
                    "context": ctx.combined_context_items,
                }
                # R-2 invariant(2026-05-10): task.caller_info는 None 또는 *정체성을 가진*
                # dict 둘 중 하나만이어야 한다. Fix A·D 후 빈 dict({})는 발생하지 않아야 한다:
                #   - 정상 진입 시 build_*_caller_info 헬퍼가 최소 source는 박는다.
                #   - resume 시 task_factory._has_identity 가드(R-2)가 빈 신원 덮어쓰기 차단.
                # 빈 dict인 경우 본 가드(truthy 검사)가 wire에서 누락시키므로 G-4의 안전망 —
                # 정상 흐름에서는 *발생하면 안 됨* (atom 7583fabd).
                if task.caller_info:
                    user_msg_event["caller_info"] = task.caller_info
                if task.attachment_paths:
                    user_msg_event["attachments"] = task.attachment_paths
                event_id = await self._persistence.persist_event(session_id, user_msg_event)
                user_msg_event["_event_id"] = event_id
                current_user_request_id = event_id  # int 유지 (parent_event_id 컬럼이 INTEGER)
                if event_id is not None:
                    task.last_event_id = event_id
                await self._listener_manager.broadcast(session_id, user_msg_event)
                try:
                    await self._persistence.update_last_message(
                        session_id, user_msg_event, task
                    )
                except Exception:
                    logger.debug("last_message update failed for user_message")
            except Exception as e:
                logger.warning(f"Failed to persist user_message for {session_id}: {e}")

        return current_user_request_id

    async def _consume_event_stream(
        self,
        task: Task,
        event_iter,
        request_id_ref: list,
    ) -> tuple[Optional[str], Optional[str]]:
        """Claude 이벤트 스트림 소비: 영속화, 브로드캐스트, 메타데이터 추출, 완료 추적.

        request_id_ref: [current_user_request_id] — parent_event_id 채움용 mutable 참조
        Returns: (last_result, last_error) — 스트림 종료 시의 완료/오류 상태
        """
        session_id = task.agent_session_id
        last_result: Optional[str] = None
        last_error: Optional[str] = None

        # 턴 phase 추적 — 멀티턴 Claude Code 세션은 'complete' 이벤트 후 다음 turn까지 task가
        # alive 상태로 남기 때문에 task.status는 RUNNING이 유지된다.
        # 클라이언트 UX(타이핑 인디케이터, 헤더 도트)는 "응답 생성 중"과 "다음 입력 대기 중"을
        # 구분해야 자연스러우므로 wire-level status를 phase 단위로 emit한다.
        # (task.status에는 영향 없음 — 영구 저장은 finalize_task만 책임진다.)
        turn_phase: str = "running"

        async for event in event_iter:
            event_dict = event.model_dump()

            # intervention_sent는 콜백에서 이미 처리됨
            if event.type == "intervention_sent":
                continue

            # Phase 2-B-1: parent_event_id fallback 채움 라인 폐기 (2026-05-08).
            # 신규 row의 parent_event_id는 NULL로 broadcast되며, FE는 평탄화로 무시한다
            # (Phase 2-A: event-processor.ts:93-104 no-op + tree-placer가 모든 노드를
            # root.children에 push). 슬랙봇은 PR #11(db7f31b6)에서 단일 활성 슬롯 모델로
            # 전환하여 무의존이 되었다.

            # claude_session_id 등록 (인터벤션 역인덱스)
            if event.type == "session" and self._register_session:
                await self._register_session(
                    event_dict.get("session_id", ""),
                    session_id,
                )

            # 진행 상황 저장 (재연결용)
            if event.type == "progress":
                task.last_progress_text = event_dict.get("text", "")
            # 어시스턴트 응답 텍스트 캐시 — push body·세션 카드 preview용.
            elif event.type in ("text_delta", "text_end"):
                text = event_dict.get("text") or ""
                if text:
                    task.last_assistant_text = text
            elif event.type == "assistant_message":
                content = event_dict.get("content") or ""
                if isinstance(content, str) and content:
                    task.last_assistant_text = content

            # 이벤트 영속화 — Phase 2-B-1(2026-05-08): persist_with_subtree 폐기.
            # subtree_update 발신을 함께 폐기했으므로 _event_id 주입과 last_event_id
            # 갱신을 호출자가 inline으로 책임진다 (단일 호출자, design-principles §1·§9).
            #
            # try/except 가드(design-principles §8 실패 격리): DB 영속화 실패가
            # broadcast·다음 이벤트를 죽이지 않는다. 기존 persist_with_subtree의
            # silent skip 동작을 보존한다. _event_id는 무조건 주입(다른 호출 사이트
            # L141, L162, L369와 패턴 일치).
            event_id: Optional[int] = None
            try:
                event_id = await self._persistence.persist_event(session_id, event_dict)
            except Exception as e:
                logger.warning(f"Failed to persist event for {session_id}: {e}")
            event_dict["_event_id"] = event_id
            if event_id is not None:
                task.last_event_id = event_id

            # 브로드캐스트
            await self._listener_manager.broadcast(session_id, event_dict)

            # DB 부수효과 (last_message, metadata, away_summary)
            await self._persistence.handle_side_effects(
                session_id, event.type, event_dict, task
            )

            # 완료/오류 추적 + phase 전환
            if event.type == "complete":
                last_result = event.result
                turn_phase = await self._emit_phase_transition(task, "idle", turn_phase)
            elif event.type == "error":
                last_error = event.message
            elif event.type not in ("session", "progress", "prompt_suggestion"):
                turn_phase = await self._emit_phase_transition(task, "running", turn_phase)

        return last_result, last_error

    async def _emit_phase_transition(
        self, task: Task, target_phase: str, current_phase: str
    ) -> str:
        """턴 phase 전환이 필요하면 브로드캐스트하고 새 phase를 반환한다."""
        if current_phase == target_phase:
            return current_phase
        try:
            count = await get_session_broadcaster().emit_session_phase(task, target_phase)
            logger.info(
                "[PHASE] %s -> %d listener(s), phase=%s",
                task.agent_session_id, count, target_phase,
            )
        except Exception:
            logger.warning(
                "[PHASE] %s broadcast skipped (broadcaster not ready) sid=%s",
                target_phase, task.agent_session_id,
            )
        return target_phase

    @asynccontextmanager
    async def _handle_execution_errors(
        self,
        task: Task,
        session_id: str,
        request_id_ref: list,
    ):
        """_run_execution의 에러 처리 + finally 블록 캡슐화.

        request_id_ref: [current_user_request_id] — 에러 시 broadcast의 parent_event_id로 사용
        """
        try:
            yield
        except RuntimeError as e:
            error_msg = str(e)
            logger.error(f"Resource acquisition failed for session {session_id}: {error_msg}")
            await self._finalize_task(session_id, error=error_msg)
            await self._listener_manager.broadcast(
                session_id, {"type": "error", "message": error_msg, "parent_event_id": request_id_ref[0]}
            )
        except asyncio.CancelledError:
            logger.info(f"Task execution cancelled: {session_id}")
            raise
        except Exception as e:
            logger.exception(f"Task execution error for {session_id}: {e}")
            error_msg = f"실행 오류: {str(e)}"
            await self._finalize_task(session_id, error=error_msg)
            await self._listener_manager.broadcast(
                session_id, {"type": "error", "message": error_msg, "parent_event_id": request_id_ref[0]}
            )
        finally:
            task.execution_task = None
            task._deliver_input_response = None
            task._runner = None
            task.pid = None  # 프로세스 종료 후 stale PID 방지
            logger.info(f"Background execution finished for session: {session_id}")

    async def _run_execution(
        self,
        task: Task,
        claude_runner,
        resource_manager,
    ) -> None:
        """백그라운드에서 Claude 실행 및 이벤트 브로드캐스트"""
        session_id = task.agent_session_id
        request_id_ref: list = [None]  # current_user_request_id 공유 참조

        async with self._handle_execution_errors(task, session_id, request_id_ref):
            async with resource_manager.acquire(timeout=5.0):
                ctx = await self._context_builder.build(task, claude_runner)
                request_id_ref[0] = await self._persist_initial_messages(task, ctx)

                effective_workspace_dir = ctx.working_dir or claude_runner.workspace_dir

                # 개입 메시지 가져오기 함수
                async def get_intervention():
                    return await self._get_intervention(session_id)

                # 개입 메시지 전송 콜백 (execute 메서드 내부 nested closure — self/task/ctx outer scope 참조).
                # F-10A fix(2026-05-08): caller_info를 broadcast dict + DB 영속 dict 양쪽에 박는다.
                # F-9 fix는 InterventionSentEvent에만 caller_info를 박았으나 본 콜백이 caller_info를
                # 받지 못해 영속·broadcast dict에는 누락되었다 — F-10B fix가 engine_adapter에서
                # caller_info forward를 추가했고 본 fix가 콜백 시그니처/dict에 박음.
                async def on_intervention_sent(
                    user: str,
                    text: str,
                    attachment_paths: list | None = None,
                    caller_info: dict | None = None,
                ):
                    # P2-3 wire 마무리 (260518.06): context 키를 _db 가드 *밖*에서 박아
                    # broadcast가 모든 path(정상 · _db None · persist 실패)에서 context 운반.
                    # build_soulstream_context_item은 순수 dict 빌더라 raise 안 함
                    # (context_builder.py:17-69 내부 try/except로 socket·get_settings fallback).
                    # design-principles §3(persist·broadcast 동일 event dict 정본 하나)
                    # + §8(빌더 실패 시에만 context skip) + §9(UserMessage·InterventionMessage
                    # 양쪽 wire 모두 context 운반 대칭).
                    #
                    # 직전 사이클(Y-4, 89b13d9b)이 event/intervention_msg dict를 단일 event로 통합.
                    # 본 사이클은 그 통합된 dict에 context를 *항상* 박아 wire 마무리.
                    # 키 박는 순서:
                    #  ① context 키 — _db 가드 *밖* + persist *전* → DB persist payload 포함 + broadcast 운반
                    #  ② _event_id 키 — persist *이후* → broadcast carry (DB 컬럼에는 미저장, ride-along)
                    event = {"type": "intervention_sent", "user": user, "text": text}
                    if attachment_paths:
                        event["attachments"] = attachment_paths
                    if caller_info:
                        event["caller_info"] = caller_info
                    intervention_soulstream = build_soulstream_context_item(
                        agent_session_id=task.agent_session_id,
                        claude_session_id=task.resume_session_id,
                        workspace_dir=effective_workspace_dir,
                        folder_name=ctx.folder_name,
                        agent_id=task.profile_id,
                    )
                    event["context"] = [intervention_soulstream]
                    if self._db is not None:
                        try:
                            ev_id = await self._persistence.persist_event(session_id, event)
                            request_id_ref[0] = ev_id  # int 유지 (parent_event_id 컬럼이 INTEGER)
                            # ② _event_id 키를 persist *이후* 박아 broadcast에 carry
                            event["_event_id"] = ev_id
                            if ev_id is not None:
                                task.last_event_id = ev_id
                        except Exception as e:
                            logger.warning(f"Failed to persist intervention user_message for {session_id}: {e}")
                    await self._listener_manager.broadcast(session_id, event)
                    try:
                        await self._persistence.update_last_message(
                            session_id, event, task
                        )
                    except Exception:
                        logger.debug("last_message update failed for intervention_sent")

                # AskUserQuestion 응답 전달 경로 구축 + pid 기록
                def on_runner_ready(runner):
                    task._deliver_input_response = runner.deliver_input_response
                    task._runner = runner
                    task.pid = runner._lifecycle.pid

                event_iter = claude_runner.execute(
                    prompt=ctx.assembled_prompt,
                    resume_session_id=task.resume_session_id,
                    get_intervention=get_intervention,
                    on_intervention_sent=on_intervention_sent,
                    allowed_tools=ctx.effective_allowed_tools,
                    disallowed_tools=ctx.effective_disallowed_tools,
                    use_mcp=task.use_mcp,
                    on_runner_ready=on_runner_ready,
                    context_items=ctx.combined_context_items,
                    agent_session_id=task.agent_session_id,
                    model=task.model,
                    system_prompt=ctx.effective_system_prompt,
                    working_dir=ctx.working_dir,
                    max_turns=ctx.max_turns,
                    extra_env=ctx.extra_env,
                )

                last_result, last_error = await self._consume_event_stream(
                    task, event_iter, request_id_ref
                )

                # 스트림 종료 후 finalize
                if last_error is not None:
                    if task.status == TaskStatus.INTERRUPTED:
                        logger.info(
                            "Session interrupted; skipping error finalize: %s",
                            session_id,
                        )
                    else:
                        await self._finalize_task(session_id, error=last_error)
                elif last_result is not None:
                    if task.status == TaskStatus.INTERRUPTED:
                        logger.info(
                            "Session interrupted; skipping completed finalize: %s",
                            session_id,
                        )
                    else:
                        await self._finalize_task(session_id, result=last_result)
                else:
                    if task.status == TaskStatus.INTERRUPTED:
                        logger.info(
                            "Interrupted stream ended without complete/error: %s",
                            session_id,
                        )
                    else:
                        logger.warning(f"Stream ended without complete/error for {session_id}")
                        await self._finalize_task(session_id, error="Stream ended without completion event")

    def is_execution_running(self, agent_session_id: str) -> bool:
        """세션 실행이 진행 중인지 확인"""
        task = self._tasks.get(agent_session_id)
        return task is not None and task.execution_task is not None

    async def send_reconnect_status(
        self,
        agent_session_id: str,
        queue: asyncio.Queue,
        last_event_id: Optional[int] = None,
    ) -> None:
        """
        재연결 시 현재 상태 이벤트 전송

        새로 연결된 리스너에게 현재 세션 상태를 알려줍니다.
        last_event_id가 주어지면 EventStore에서 미수신 이벤트를 재전송합니다.

        Args:
            agent_session_id: 세션 식별자
            queue: 이벤트를 받을 큐
            last_event_id: 클라이언트가 마지막으로 수신한 이벤트 ID
        """
        task = self._tasks.get(agent_session_id)
        if not task:
            return

        # 재연결 알림 이벤트
        reconnect_event = {
            "type": "reconnected",
            "status": task.status.value,
            "has_execution": task.execution_task is not None,
        }

        if task.last_progress_text:
            reconnect_event["last_progress"] = task.last_progress_text

        try:
            await queue.put(reconnect_event)
            logger.debug(f"Sent reconnect status to listener for session {agent_session_id}")

            # SessionDB에서 미수신 이벤트 스트리밍 재전송
            if self._db is not None and last_event_id is not None:
                try:
                    replayed = 0
                    async for event_id, event_type, payload_text in self._db.stream_events_raw(
                        agent_session_id, after_id=last_event_id,
                    ):
                        try:
                            normalized = json.loads(payload_text)
                        except json.JSONDecodeError:
                            normalized = {}
                        normalized["_event_id"] = event_id
                        await queue.put(normalized)
                        replayed += 1
                    if replayed:
                        logger.info(
                            f"Replayed {replayed} missed events for {agent_session_id} "
                            f"(after_id={last_event_id})"
                        )
                except Exception as e:
                    logger.warning(f"Failed to replay events from store: {e}")

        except Exception as e:
            logger.warning(f"Failed to send reconnect status: {e}")

    async def cancel_running_tasks(self, timeout: float = 5.0) -> int:
        """
        실행 중인 모든 태스크 취소

        서비스 shutdown 시 호출하여 고아 프로세스 방지.

        Args:
            timeout: 취소 대기 시간 (초)

        Returns:
            취소된 태스크 수
        """
        tasks_to_cancel = []

        for key, task in self._tasks.items():
            if task.execution_task and not task.execution_task.done():
                task.execution_task.cancel()
                tasks_to_cancel.append((key, task.execution_task))
                logger.info(f"Cancelling execution for session: {key}")

        if not tasks_to_cancel:
            return 0

        try:
            await asyncio.wait_for(
                asyncio.gather(
                    *[t for _, t in tasks_to_cancel],
                    return_exceptions=True
                ),
                timeout=timeout
            )
        except asyncio.TimeoutError:
            logger.warning(f"Task cancellation timeout after {timeout}s")

        cancelled_count = sum(1 for _, t in tasks_to_cancel if t.done())
        logger.info(f"Cancelled {cancelled_count}/{len(tasks_to_cancel)} running tasks")
        return cancelled_count
