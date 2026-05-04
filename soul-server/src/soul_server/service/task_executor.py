"""
Task Executor - 백그라운드 태스크 실행 관리

세션(agent_session_id) 단위로 Claude Code 실행을 백그라운드에서 관리합니다.
"""

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Callable, Awaitable, Optional, TYPE_CHECKING

from soul_common.db.session_db_base import extract_searchable_text
from soul_server.service.atom_context import fetch_atom_context
from soul_server.service.task_models import Task, TaskStatus, PREVIEW_FIELD_MAP, datetime_to_str, utc_now
from soul_server.service.prompt_assembler import assemble_prompt
from soul_server.service.session_broadcaster import get_session_broadcaster
from soul_server.service.context_builder import build_soulstream_context_item
from soul_server.config import get_settings


@dataclass
class _PreparedContext:
    """_run_execution의 컨텍스트 준비 단계 결과물"""
    effective_system_prompt: Optional[str] = None
    combined_context_items: list = field(default_factory=list)
    folder_name: Optional[str] = None
    working_dir: Optional[Path] = None
    max_turns: Optional[int] = None
    effective_allowed_tools: Optional[list] = None
    effective_disallowed_tools: Optional[list] = None
    extra_env: Optional[dict] = None
    assembled_prompt: str = ""

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
        self._metadata_extractor = metadata_extractor
        self._append_metadata = append_metadata_func
        self._registry = agent_registry

    async def _persist_event(self, session_id: str, event_dict: dict) -> Optional[int]:
        """이벤트를 SessionDB에 영속화하고 event_id를 반환한다."""
        if self._db is None:
            return None
        event_type = event_dict.get("type", "")
        payload = json.dumps(event_dict, ensure_ascii=False)
        searchable = extract_searchable_text(event_dict)
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

    async def _prepare_context(
        self,
        task: Task,
        claude_runner,
    ) -> _PreparedContext:
        """_run_execution의 컨텍스트 준비 단계를 담당한다.

        폴더 설정 조회, atom 트리 fetch, 프로필 해석, 프롬프트 조립을 수행한다.
        """
        session_id = task.agent_session_id
        folder_name: Optional[str] = None
        folder_prompt: Optional[str] = None
        atom_context_markdown: str | None = None

        if self._db is not None:
            session_row = await self._db.get_session(session_id)
            if session_row and session_row.get("folder_id"):
                folder_row = await self._db.get_folder(session_row["folder_id"])
                if folder_row:
                    folder_name = folder_row["name"]
                    # 새 세션에서만 폴더 프롬프트 + atom 트리 주입 (resume/intervention 제외)
                    if task.resume_session_id is None:
                        folder_settings = folder_row.get("settings")
                        if isinstance(folder_settings, dict):
                            folder_prompt = folder_settings.get("folderPrompt") or None
                            atom_node_cfg = folder_settings.get("atomContextNode")
                            if isinstance(atom_node_cfg, dict) and atom_node_cfg.get("nodeId"):
                                atom_context_markdown = await fetch_atom_context(
                                    node_id=atom_node_cfg["nodeId"],
                                    depth=int(atom_node_cfg.get("depth", 3)),
                                    titles_only=bool(atom_node_cfg.get("titlesOnly", False)),
                                )

        # 폴더 프롬프트를 system_prompt에 합산 (새 세션에서만)
        effective_system_prompt = task.system_prompt
        if folder_prompt:
            if effective_system_prompt:
                effective_system_prompt = folder_prompt + "\n\n" + effective_system_prompt
            else:
                effective_system_prompt = folder_prompt

        # profile_id로 프로필 조회 및 실행 옵션 추출
        if task.profile_id and self._registry:
            profile = self._registry.get(task.profile_id)
            working_dir = profile.workspace_dir if profile else None
            max_turns = profile.max_turns if profile else None
            override_tools = profile.allowed_tools if profile else None
            override_disallowed = profile.disallowed_tools if profile else None
        else:
            working_dir = None
            max_turns = None
            override_tools = None
            override_disallowed = None

        effective_workspace_dir = working_dir or claude_runner.workspace_dir

        # 서버 컨텍스트 빌드 + 클라이언트 컨텍스트 머지
        soulstream_item = build_soulstream_context_item(
            agent_session_id=task.agent_session_id,
            claude_session_id=task.resume_session_id,
            workspace_dir=effective_workspace_dir,
            folder_name=folder_name,
            agent_id=task.profile_id,
            caller_info=task.caller_info,
        )
        atom_context_items = (
            [{"key": "atom_context", "label": "atom 트리", "content": atom_context_markdown}]
            if atom_context_markdown
            else []
        )
        combined_context_items = (
            [soulstream_item]
            + atom_context_items
            + (task.context_items or [])
        )

        # allowed_tools / disallowed_tools 병합: task 설정 우선, None이면 profile 설정 사용
        effective_allowed_tools = task.allowed_tools if task.allowed_tools is not None else override_tools
        effective_disallowed_tools = task.disallowed_tools if task.disallowed_tools is not None else override_disallowed

        # CLAUDE_CODE_OAUTH_TOKEN 주입
        extra_env: Optional[dict] = None
        if task.oauth_token:
            extra_env = {"CLAUDE_CODE_OAUTH_TOKEN": task.oauth_token}

        assembled_prompt = assemble_prompt(task.prompt, task.context)

        return _PreparedContext(
            effective_system_prompt=effective_system_prompt,
            combined_context_items=combined_context_items,
            folder_name=folder_name,
            working_dir=working_dir,
            max_turns=max_turns,
            effective_allowed_tools=effective_allowed_tools,
            effective_disallowed_tools=effective_disallowed_tools,
            extra_env=extra_env,
            assembled_prompt=assembled_prompt,
        )

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
                event_id = await self._persist_event(session_id, sys_msg_event)
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
                if task.caller_info:
                    user_msg_event["caller_info"] = task.caller_info
                if task.attachment_paths:
                    user_msg_event["attachments"] = task.attachment_paths
                event_id = await self._persist_event(session_id, user_msg_event)
                user_msg_event["_event_id"] = event_id
                current_user_request_id = event_id  # int 유지 (parent_event_id 컬럼이 INTEGER)
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

            # parent_event_id 채움
            if "parent_event_id" in event_dict and event_dict["parent_event_id"] is None:
                event_dict["parent_event_id"] = request_id_ref[0]

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
            # TextDeltaSSEEvent.text는 block.text 전체(청크 아님, task_models 주석 참조)이므로
            # 매 text_delta마다 덮어쓰면 자연스럽게 stream 끝에 응답 전체가 남는다.
            elif event.type in ("text_delta", "text_end"):
                text = event_dict.get("text") or ""
                if text:
                    task.last_assistant_text = text

            # 이벤트 영속화 + subtree_update 계산
            subtree_update_dict: Optional[dict] = None
            if self._db is not None:
                try:
                    event_id = await self._persist_event(session_id, event_dict)
                    event_dict["_event_id"] = event_id
                    if event_id is not None:
                        task.last_event_id = event_id

                    # 조상 이벤트들의 subtree_height 전파 + subtree_update SSE 이벤트 생성
                    # parent_event_id가 있을 때만 (루트 이벤트는 조상 없음)
                    if event_id is not None and event_dict.get("parent_event_id") is not None:
                        try:
                            deltas, new_total = await self._db.update_subtree_heights(
                                session_id, event_id, increment=1
                            )
                            subtree_update_dict = {
                                "type": "subtree_update",
                                "timestamp": time.time(),
                                "affected_event_ids": list(deltas.keys()),
                                "deltas": deltas,
                                "new_total_subtree_height": new_total,
                                "trigger_event_id": event_id,
                            }
                            # subtree_update도 영속화 (재연결 복구용)
                            subtree_event_id = await self._persist_event(
                                session_id, subtree_update_dict
                            )
                            subtree_update_dict["_event_id"] = subtree_event_id
                        except Exception as e:
                            logger.warning(
                                f"Failed to compute subtree_update for {session_id}: {e}"
                            )
                            subtree_update_dict = None
                except Exception as e:
                    logger.warning(f"Failed to persist event for {session_id}: {e}")
                    subtree_update_dict = None

            # 브로드캐스트 (원본 이벤트 → subtree_update 순)
            await self._listener_manager.broadcast(session_id, event_dict)
            if subtree_update_dict is not None:
                await self._listener_manager.broadcast(session_id, subtree_update_dict)
            try:
                await self._update_and_broadcast_last_message(
                    session_id, event_dict, task
                )
            except Exception:
                logger.debug("last_message update failed")

            # tool_result 메타데이터 자동 추출
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

            # away_summary → sessions.away_summary에 저장
            if event.type == "away_summary" and self._db is not None:
                try:
                    await self._db.update_away_summary(
                        session_id, event_dict.get("content", "")
                    )
                except Exception:
                    logger.debug("away_summary DB update failed")

            # 완료/오류 추적 (finalize는 루프 밖에서)
            if event.type == "complete":
                last_result = event.result
                # 한 턴 종료 — 클라이언트에 idle phase 통보. task.status는 RUNNING 유지.
                if turn_phase != "idle":
                    try:
                        count = await get_session_broadcaster().emit_session_phase(task, "idle")
                        logger.info(
                            "[PHASE] %s -> %d listener(s), phase=idle",
                            task.agent_session_id, count,
                        )
                    except Exception:
                        logger.warning(
                            "[PHASE] idle broadcast skipped (broadcaster not ready) sid=%s",
                            task.agent_session_id,
                        )
                    turn_phase = "idle"
            elif event.type == "error":
                last_error = event.message
                # error는 finalize에서 ERROR 상태로 정리하므로 phase 전환 불필요.
            elif event.type not in ("subtree_update", "session", "progress"):
                # 일반 활성 이벤트(text_*/thinking_*/tool_*/...) — 응답 생성 중.
                # subtree_update/session/progress는 메타 이벤트이므로 phase 전환에서 제외.
                if turn_phase != "running":
                    try:
                        count = await get_session_broadcaster().emit_session_phase(task, "running")
                        logger.info(
                            "[PHASE] %s -> %d listener(s), phase=running",
                            task.agent_session_id, count,
                        )
                    except Exception:
                        logger.warning(
                            "[PHASE] running broadcast skipped (broadcaster not ready) sid=%s",
                            task.agent_session_id,
                        )
                    turn_phase = "running"

        return last_result, last_error

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
                ctx = await self._prepare_context(task, claude_runner)
                request_id_ref[0] = await self._persist_initial_messages(task, ctx)

                effective_workspace_dir = ctx.working_dir or claude_runner.workspace_dir

                # 개입 메시지 가져오기 함수
                async def get_intervention():
                    return await self._get_intervention(session_id)

                # 개입 메시지 전송 콜백
                async def on_intervention_sent(user: str, text: str, attachment_paths: list | None = None):
                    event = {"type": "intervention_sent", "user": user, "text": text}
                    if attachment_paths:
                        event["attachments"] = attachment_paths
                    if self._db is not None:
                        try:
                            intervention_soulstream = build_soulstream_context_item(
                                agent_session_id=task.agent_session_id,
                                claude_session_id=task.resume_session_id,
                                workspace_dir=effective_workspace_dir,
                                folder_name=ctx.folder_name,
                                agent_id=task.profile_id,
                            )
                            intervention_msg = {
                                "type": "intervention_sent",
                                "user": user,
                                "text": text,
                                "context": [intervention_soulstream],
                            }
                            if attachment_paths:
                                intervention_msg["attachments"] = attachment_paths
                            ev_id = await self._persist_event(session_id, intervention_msg)
                            request_id_ref[0] = ev_id  # int 유지 (parent_event_id 컬럼이 INTEGER)
                            event["_event_id"] = ev_id
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
                    await self._finalize_task(session_id, error=last_error)
                elif last_result is not None:
                    await self._finalize_task(session_id, result=last_result)
                else:
                    logger.warning(f"Stream ended without complete/error for {session_id}")
                    await self._finalize_task(session_id, error="Stream ended without completion event")

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
