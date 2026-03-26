"""
Task Executor - 백그라운드 태스크 실행 관리

세션(agent_session_id) 단위로 Claude Code 실행을 백그라운드에서 관리합니다.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Dict, Callable, Awaitable, Optional, TYPE_CHECKING

from soul_server.service.task_models import Task, TaskStatus, PREVIEW_FIELD_MAP, datetime_to_str, utc_now
from soul_server.service.prompt_assembler import assemble_prompt
from soul_server.service.session_broadcaster import get_session_broadcaster
from soul_server.service.engine_adapter import build_soulstream_context_item

import json

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
        register_session_func: Optional[Callable[..., None]] = None,
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
        self._metadata_extractor = metadata_extractor
        self._append_metadata = append_metadata_func
        self._registry = agent_registry

    async def _persist_event(self, session_id: str, event_dict: dict) -> Optional[int]:
        """이벤트를 SessionDB에 영속화하고 event_id를 반환한다."""
        if self._db is None:
            return None
        from soul_server.service.postgres_session_db import PostgresSessionDB
        event_type = event_dict.get("type", "")
        payload = json.dumps(event_dict, ensure_ascii=False)
        searchable = PostgresSessionDB.extract_searchable_text(event_dict)
        ts = event_dict.get("timestamp")
        if isinstance(ts, (int, float)):
            created_at = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
        elif isinstance(ts, str):
            created_at = ts
        else:
            created_at = utc_now().isoformat()
        event_id = await self._db.append_event(session_id, event_type, payload, searchable, created_at)
        return event_id

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

    async def _run_execution(
        self,
        task: Task,
        claude_runner,
        resource_manager,
    ) -> None:
        """백그라운드에서 Claude 실행 및 이벤트 브로드캐스트"""
        session_id = task.agent_session_id

        try:
            current_user_request_id: Optional[str] = None  # except에서 NameError 방지
            async with resource_manager.acquire(timeout=5.0):
                # 세션의 폴더명 조회
                folder_name: Optional[str] = None
                if self._db is not None:
                    session_row = await self._db.get_session(session_id)
                    if session_row and session_row.get("folder_id"):
                        folder_row = await self._db.get_folder(session_row["folder_id"])
                        if folder_row:
                            folder_name = folder_row["name"]

                # 서버 컨텍스트 빌드 + 클라이언트 컨텍스트 머지
                # SSE 이벤트와 프롬프트 주입 양쪽에 동일한 머지 결과를 사용
                soulstream_item = build_soulstream_context_item(
                    agent_session_id=task.agent_session_id,
                    claude_session_id=task.resume_session_id,
                    workspace_dir=claude_runner.workspace_dir,
                    folder_name=folder_name,
                )
                combined_context_items = [soulstream_item] + (task.context_items or [])

                # user_message 기록
                if self._db is not None:
                    try:
                        user_msg_event = {
                            "type": "user_message",
                            "user": task.client_id or "unknown",
                            "text": task.prompt,
                            "context": combined_context_items,
                        }
                        event_id = await self._persist_event(session_id, user_msg_event)
                        user_msg_event["_event_id"] = event_id
                        current_user_request_id = str(event_id)
                        if event_id is not None:
                            task.last_event_id = event_id
                        await self._listener_manager.broadcast(session_id, user_msg_event)
                        try:
                            await self._update_and_broadcast_last_message(
                                session_id, user_msg_event, task
                            )
                        except Exception:
                            logger.debug("last_message update failed for user_message")
                    except Exception as e:
                        logger.warning(f"Failed to persist user_message for {session_id}: {e}")

                # 개입 메시지 가져오기 함수
                async def get_intervention():
                    return await self._get_intervention(session_id)

                # 개입 메시지 전송 콜백
                async def on_intervention_sent(user: str, text: str):
                    nonlocal current_user_request_id
                    event = {"type": "intervention_sent", "user": user, "text": text}
                    # intervention을 user_message로도 JSONL에 기록
                    if self._db is not None:
                        try:
                            intervention_soulstream = build_soulstream_context_item(
                                agent_session_id=task.agent_session_id,
                                claude_session_id=task.resume_session_id,
                                workspace_dir=claude_runner.workspace_dir,
                                folder_name=folder_name,
                            )
                            intervention_msg = {
                                "type": "user_message",
                                "user": user,
                                "text": text,
                                "context": [intervention_soulstream],
                            }
                            ev_id = await self._persist_event(session_id, intervention_msg)
                            current_user_request_id = str(ev_id)
                            event["_event_id"] = ev_id  # SSE id: 필드에 JSONL event_id 전달
                            if ev_id is not None:
                                task.last_event_id = ev_id
                        except Exception as e:
                            logger.warning(f"Failed to persist intervention user_message for {session_id}: {e}")
                    await self._listener_manager.broadcast(session_id, event)
                    try:
                        await self._update_and_broadcast_last_message(
                            session_id, event, task
                        )
                    except Exception:
                        logger.debug("last_message update failed for intervention_sent")

                # AskUserQuestion 응답 전달 경로 구축 + pid 기록
                def on_runner_ready(runner):
                    task._deliver_input_response = runner.deliver_input_response
                    task.pid = runner.pid

                # profile_id로 프로필 조회 및 실행 옵션 추출
                if task.profile_id and self._registry:
                    profile = self._registry.get(task.profile_id)
                    working_dir = profile.workspace_dir if profile else None
                    max_turns = profile.max_turns if profile else None
                    override_tools = profile.allowed_tools if profile else None
                    # AgentProfile.disallowed_tools는 현재 사용하지 않음.
                    # task.disallowed_tools (L252)가 그대로 적용된다.
                    # 프로필 레벨 disallowed_tools 오버라이드는 필요 시 추가.
                else:
                    working_dir = None
                    max_turns = None
                    override_tools = None

                # allowed_tools 병합: task 설정 우선, None이면 profile 설정 사용
                # task.allowed_tools or override_tools 사용 금지 — 빈 리스트([])를 falsy로 처리함
                effective_allowed_tools = task.allowed_tools if task.allowed_tools is not None else override_tools

                # 구조화된 맥락을 XML 섹션으로 조립
                assembled_prompt = assemble_prompt(task.prompt, task.context)

                # Claude Code 실행
                async for event in claude_runner.execute(
                    prompt=assembled_prompt,
                    resume_session_id=task.resume_session_id,
                    get_intervention=get_intervention,
                    on_intervention_sent=on_intervention_sent,
                    allowed_tools=effective_allowed_tools,
                    disallowed_tools=task.disallowed_tools,
                    use_mcp=task.use_mcp,
                    on_runner_ready=on_runner_ready,
                    context_items=combined_context_items,
                    agent_session_id=task.agent_session_id,
                    model=task.model,
                    system_prompt=task.system_prompt,
                    working_dir=working_dir,
                    max_turns=max_turns,
                ):
                    event_dict = event.model_dump()

                    # intervention_sent는 on_intervention_sent 콜백에서
                    # 이미 영속화 + 브로드캐스트를 수행했으므로 메인 루프에서 중복 처리하지 않는다.
                    if event.type == "intervention_sent":
                        continue

                    # parent_event_id 채움 (규칙 3: parent_tool_use_id 없음 → user_request의 자식)
                    # parent_event_id 필드를 가진 이벤트에만 적용.
                    # progress, session, memory, compact 등 메타 이벤트는
                    # 해당 필드가 model에 없으므로 model_dump()에 키가 없어 자동 제외.
                    if "parent_event_id" in event_dict and event_dict["parent_event_id"] is None:
                        event_dict["parent_event_id"] = current_user_request_id

                    # claude_session_id 등록 (인터벤션 역인덱스)
                    if event.type == "session" and self._register_session:
                        self._register_session(
                            event_dict.get("session_id", ""),
                            session_id,
                            agent_id=task.profile_id,
                        )

                    # 진행 상황 저장 (재연결용)
                    if event.type == "progress":
                        task.last_progress_text = event_dict.get("text", "")

                    # 이벤트 영속화 (broadcast 전에 저장)
                    if self._db is not None:
                        try:
                            event_id = await self._persist_event(session_id, event_dict)
                            event_dict["_event_id"] = event_id
                            # Task 메모리 객체의 last_event_id 갱신
                            if event_id is not None:
                                task.last_event_id = event_id
                        except Exception as e:
                            logger.warning(f"Failed to persist event for {session_id}: {e}")

                    # 리스너들에게 브로드캐스트
                    await self._listener_manager.broadcast(session_id, event_dict)
                    try:
                        await self._update_and_broadcast_last_message(
                            session_id, event_dict, task
                        )
                    except Exception:
                        logger.debug("last_message update failed")

                    # tool_result 이벤트에서 메타데이터 자동 추출
                    if (
                        event.type == "tool_result"
                        and self._metadata_extractor
                        and self._append_metadata
                    ):
                        try:
                            entry = self._metadata_extractor.extract(
                                tool_name=event_dict.get("tool_name", ""),
                                result=event_dict.get("result", ""),
                                is_error=event_dict.get("is_error", False),
                            )
                            if entry:
                                await self._append_metadata(session_id, entry)
                        except Exception:
                            logger.warning(
                                f"Metadata extraction failed for {session_id}",
                                exc_info=True,
                            )

                    # 완료 또는 오류 시 태스크 상태 업데이트
                    if event.type == "complete":
                        await self._finalize_task(
                            session_id,
                            result=event.result,
                            claude_session_id=event.claude_session_id,
                        )
                    elif event.type == "error":
                        await self._finalize_task(session_id, error=event.message)

        except RuntimeError as e:
            error_msg = str(e)
            logger.error(f"Resource acquisition failed for session {session_id}: {error_msg}")
            await self._finalize_task(session_id, error=error_msg)
            await self._listener_manager.broadcast(
                session_id, {"type": "error", "message": error_msg, "parent_event_id": current_user_request_id}
            )

        except asyncio.CancelledError:
            logger.info(f"Task execution cancelled: {session_id}")
            raise

        except Exception as e:
            logger.exception(f"Task execution error for {session_id}: {e}")
            error_msg = f"실행 오류: {str(e)}"
            await self._finalize_task(session_id, error=error_msg)
            await self._listener_manager.broadcast(
                session_id, {"type": "error", "message": error_msg, "parent_event_id": current_user_request_id}
            )

        finally:
            task.execution_task = None
            task._deliver_input_response = None
            task.pid = None  # 프로세스 종료 후 stale PID 방지
            logger.info(f"Background execution finished for session: {session_id}")

    def is_execution_running(self, agent_session_id: str) -> bool:
        """세션 실행이 진행 중인지 확인"""
        task = self._tasks.get(agent_session_id)
        return task is not None and task.execution_task is not None

    async def _update_and_broadcast_last_message(
        self, session_id: str, event_dict: dict, task: Task
    ) -> None:
        """readable event의 last_message를 카탈로그에 저장하고 세션 리스트 SSE로 브로드캐스트."""
        if self._db is None:
            return

        event_type = event_dict.get("type", "")

        # user_message 전용: text 또는 messages에서 preview 추출
        if event_type == "user_message":
            text = event_dict.get("text", "")
            if not text and "messages" in event_dict:
                for m in reversed(event_dict.get("messages", [])):
                    if m.get("role") == "user":
                        c = m.get("content", "")
                        if isinstance(c, str):
                            text = c
                        elif isinstance(c, list):
                            text = " ".join(
                                p.get("text", "") for p in c
                                if isinstance(p, dict) and p.get("type") == "text"
                            )
                        break
        elif event_type == "intervention_sent":
            text = event_dict.get("text", "")
        else:
            text_field = PREVIEW_FIELD_MAP.get(event_type)
            if not text_field:
                return
            text = event_dict.get(text_field, "")

        if not isinstance(text, str) or not text:
            return

        ts = event_dict.get("timestamp")
        if isinstance(ts, (int, float)):
            ts_str = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
        elif isinstance(ts, str):
            ts_str = ts
        else:
            ts_str = datetime_to_str(utc_now())

        await self._db.update_last_message(session_id, {
            "type": event_type,
            "preview": text[:200],
            "timestamp": ts_str,
        })

        try:
            broadcaster = get_session_broadcaster()
            await broadcaster.emit_session_message_updated(
                agent_session_id=session_id,
                status=task.status.value,
                updated_at=ts_str,
                last_message={
                    "type": event_type,
                    "preview": text[:200],
                    "timestamp": ts_str,
                },
                last_event_id=task.last_event_id,
                last_read_event_id=task.last_read_event_id,
            )
        except Exception:
            logger.debug("session list broadcast skipped (broadcaster not ready)")

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
