"""
Task Executor - 백그라운드 태스크 실행 관리

세션(agent_session_id) 단위로 Claude Code 실행을 백그라운드에서 관리합니다.
"""

import asyncio
import logging
from typing import Dict, Callable, Awaitable, Optional, TYPE_CHECKING

from soul_server.service.task_models import Task, TaskStatus
from soul_server.service.prompt_assembler import assemble_prompt

if TYPE_CHECKING:
    from soul_server.service.event_store import EventStore
    from soul_server.service.task_listener import TaskListenerManager

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
        complete_task_func: Callable[[str, str, Optional[str]], Awaitable[Optional[Task]]],
        error_task_func: Callable[[str, str], Awaitable[Optional[Task]]],
        register_session_func: Optional[Callable[[str, str], None]] = None,
        event_store: Optional["EventStore"] = None,
    ):
        """
        Args:
            tasks: TaskManager의 태스크 딕셔너리 참조 (key = agent_session_id)
            listener_manager: 리스너 매니저
            get_intervention_func: 개입 메시지 가져오기 함수 (agent_session_id) -> dict?
            complete_task_func: 태스크 완료 처리 함수 (agent_session_id, result, claude_session_id?)
            error_task_func: 태스크 에러 처리 함수 (agent_session_id, error)
            register_session_func: claude_session_id 등록 함수 (claude_session_id, agent_session_id)
            event_store: 이벤트 영속화 저장소 (None이면 저장하지 않음)
        """
        self._tasks = tasks
        self._listener_manager = listener_manager
        self._get_intervention = get_intervention_func
        self._complete_task = complete_task_func
        self._error_task = error_task_func
        self._register_session = register_session_func
        self._event_store = event_store

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
                # user_message 기록 (Soul 서버가 JSONL의 유일한 기록자)
                if self._event_store is not None:
                    try:
                        user_msg_event = {
                            "type": "user_message",
                            "user": task.client_id or "unknown",
                            "text": task.prompt,
                            "context": task.context.get("items") if task.context else None,
                        }
                        event_id = self._event_store.append(session_id, user_msg_event)
                        user_msg_event["_event_id"] = event_id
                        current_user_request_id = str(event_id)
                        await self._listener_manager.broadcast(session_id, user_msg_event)
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
                    if self._event_store is not None:
                        try:
                            intervention_msg = {"type": "user_message", "user": user, "text": text}
                            ev_id = self._event_store.append(session_id, intervention_msg)
                            current_user_request_id = str(ev_id)
                            event["_event_id"] = ev_id  # SSE id: 필드에 JSONL event_id 전달
                        except Exception as e:
                            logger.warning(f"Failed to persist intervention user_message for {session_id}: {e}")
                    await self._listener_manager.broadcast(session_id, event)

                # AskUserQuestion 응답 전달 경로 구축 + pid 기록
                def on_runner_ready(runner):
                    task._deliver_input_response = runner.deliver_input_response
                    task.pid = runner.pid

                # 구조화된 맥락을 XML 섹션으로 조립
                assembled_prompt = assemble_prompt(task.prompt, task.context)

                # Claude Code 실행
                async for event in claude_runner.execute(
                    prompt=assembled_prompt,
                    resume_session_id=task.resume_session_id,
                    get_intervention=get_intervention,
                    on_intervention_sent=on_intervention_sent,
                    allowed_tools=task.allowed_tools,
                    disallowed_tools=task.disallowed_tools,
                    use_mcp=task.use_mcp,
                    on_runner_ready=on_runner_ready,
                    context_items=task.context_items,
                    agent_session_id=task.agent_session_id,
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
                        )

                    # 진행 상황 저장 (재연결용)
                    if event.type == "progress":
                        task.last_progress_text = event_dict.get("text", "")

                    # 이벤트 영속화 (broadcast 전에 저장)
                    if self._event_store is not None:
                        try:
                            event_id = self._event_store.append(session_id, event_dict)
                            event_dict["_event_id"] = event_id
                        except Exception as e:
                            logger.warning(f"Failed to persist event for {session_id}: {e}")

                    # 리스너들에게 브로드캐스트
                    await self._listener_manager.broadcast(session_id, event_dict)

                    # 완료 또는 오류 시 태스크 상태 업데이트
                    if event.type == "complete":
                        await self._complete_task(
                            session_id,
                            event.result,
                            event.claude_session_id,
                        )
                    elif event.type == "error":
                        await self._error_task(session_id, event.message)

        except RuntimeError as e:
            error_msg = str(e)
            logger.error(f"Resource acquisition failed for session {session_id}: {error_msg}")
            await self._error_task(session_id, error_msg)
            await self._listener_manager.broadcast(
                session_id, {"type": "error", "message": error_msg, "parent_event_id": current_user_request_id}
            )

        except asyncio.CancelledError:
            logger.info(f"Task execution cancelled: {session_id}")
            raise

        except Exception as e:
            logger.exception(f"Task execution error for {session_id}: {e}")
            error_msg = f"실행 오류: {str(e)}"
            await self._error_task(session_id, error_msg)
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

            # EventStore에서 미수신 이벤트 재전송
            if self._event_store is not None and last_event_id is not None:
                try:
                    missed_events = self._event_store.read_since(
                        agent_session_id, after_id=last_event_id
                    )
                    for ev in missed_events:
                        normalized = dict(ev.get("event", {}))
                        normalized["_event_id"] = ev["id"]
                        await queue.put(normalized)
                    if missed_events:
                        logger.info(
                            f"Replayed {len(missed_events)} missed events for {agent_session_id} "
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
