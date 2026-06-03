"""Submit Message Service — `/execute`와 `/api/sessions/{id}/intervene`의 정본 (design-principles §3).

기존에 두 라우트가 각각 `task_manager.create_task`와 `intervention_service.intervene`을
거치던 비대칭(정본 둘 안티패턴, atom d7a1ad86)을 본 모듈로 통합한다. 라우트는
인증·body 변환·SSE/ACK wiring·HTTPException 매핑만 담당하고, *어떤 시나리오인지 판정하고
어떤 분기로 처리할지*는 본 서비스가 단일 정본으로 결정한다.

분기 규칙
---------

- ``agent_session_id is None`` → 신규 세션 (kind='new_session')
- ``agent_session_id`` 제공 + 기존 task가 RUNNING → intervention queue 큐잉 (kind='intervened')
- ``agent_session_id`` 제공 + 기존 task가 terminal(completed/error/interrupted) → 새 task로
  재활성화한다 (kind='auto_resumed'). 일반 resume은 기존 Claude 세션을 이어야 하므로
  ``ClaudeAgentOptions.resume``에 기존 ``claude_session_id``를 전달한다.

라우트 책임
-----------

본 서비스는 ``start_execution``을 호출하지 않는다. 라우트가 결과의 kind를 보고:

- ``new_session`` / ``auto_resumed`` → start_execution + SSE listener attach (라우트 종류에 따라)
- ``intervened`` → 추가 호출 없음 (이미 running task에 큐잉됨)

DI 패턴: ``task_manager``는 라우트가 조달하여 keyword로 주입. 본 모듈은 의존성을 직접 import하지 않는다.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional

from soul_server.service.task_factory import CreateTaskParams
from soul_server.service.task_models import (
    Task,
    TaskNotFoundError,
    TaskStatus,
)
from soul_server.util.attachment_helpers import build_attachment_context_items


SubmitKind = Literal["new_session", "intervened", "auto_resumed"]


@dataclass(frozen=True)
class SubmitMessageParams:
    """submit_message의 전 인자를 응집하는 불변 파라미터.

    intervene/execute 두 라우트의 시그니처 합집합. 신규 세션 케이스에서만 의미가 있는 필드
    (allowed_tools 등)는 intervened/auto_resumed 분기에서 무시된다.
    """

    prompt: str
    agent_session_id: Optional[str] = None
    user: str = "api"  # intervene의 'user' 필드 (sender label) — running 큐잉 시 message에 박힘
    caller_info: Optional[dict] = None
    attachment_paths: Optional[list] = None
    # 신규 세션 케이스 전용 (existing task의 옵션은 재활성화 시 덮어쓰지 않는다 — task_factory 정책)
    client_id: Optional[str] = None
    allowed_tools: Optional[list] = None
    disallowed_tools: Optional[list] = None
    use_mcp: bool = True
    context: Optional[dict] = None
    context_items: Optional[list] = None
    extra_context_items: Optional[list] = None
    model: Optional[str] = None
    folder_id: Optional[str] = None
    system_prompt: Optional[str] = None
    profile_id: Optional[str] = None
    oauth_token: Optional[str] = None
    caller_session_id: Optional[str] = None
    # orch-server는 새 세션 ID를 먼저 발급해 노드에 전달한다. 일반 intervene/resume의
    # "없는 세션이면 에러" 정책과 구분하기 위해 upstream create_session에서만 True로 둔다.
    allow_new_session_with_id: bool = False


@dataclass
class SubmitMessageResult:
    """submit_message의 결과.

    Attributes:
        kind: 분기 결과 — 'new_session' | 'intervened' | 'auto_resumed'
        agent_session_id: 결정된 세션 식별자 (신규 케이스는 서버 생성)
        task: 신규/재활성화된 Task. intervened 케이스에서도 기존 running Task 참조로 반환되어
              라우트가 listener attach 등에 사용할 수 있다.
        queue_position: kind='intervened'에서만 의미. running 세션의 intervention_queue 크기.
    """

    kind: SubmitKind
    agent_session_id: str
    task: Task
    queue_position: Optional[int] = None


async def submit_message(
    params: SubmitMessageParams,
    *,
    task_manager,
) -> SubmitMessageResult:
    """단일 정본 — 신규/running 개입/terminal 재개를 모두 처리.

    Args:
        params: 입력 파라미터 (SubmitMessageParams).
        task_manager: TaskManager 인스턴스 (라우트가 주입).

    Returns:
        SubmitMessageResult — kind 분류와 함께 task 참조 반환.

    Raises:
        TaskNotFoundError: agent_session_id 제공됐지만 메모리·DB 어디에도 task가 없을 때.
        TaskConflictError: 신규 세션 생성 시 agent_session_id가 이미 RUNNING (드물게 race).
        NodeMismatchError: 다른 노드 소속 세션의 resume 시도.
        ValueError: profile_id가 registry에 없는 경우.
    """
    # 신규 세션 케이스 — agent_session_id 미제공
    if params.agent_session_id is None:
        task = await task_manager.create_task(
            CreateTaskParams(
                prompt=params.prompt,
                agent_session_id=None,
                client_id=params.client_id or params.user,
                allowed_tools=params.allowed_tools,
                disallowed_tools=params.disallowed_tools,
                use_mcp=params.use_mcp,
                context=params.context,
                context_items=params.context_items,
                extra_context_items=params.extra_context_items,
                model=params.model,
                folder_id=params.folder_id,
                system_prompt=params.system_prompt,
                profile_id=params.profile_id,
                oauth_token=params.oauth_token,
                caller_session_id=params.caller_session_id,
                caller_info=params.caller_info,
                attachment_paths=params.attachment_paths,
                skip_claude_resume=False,  # 신규 세션 — resume_session_id 박지 않음 (영향 없음)
            )
        )
        return SubmitMessageResult(
            kind="new_session",
            agent_session_id=task.agent_session_id,
            task=task,
        )

    # 기존 세션 케이스 — agent_session_id 제공
    agent_session_id = params.agent_session_id
    existing = task_manager._tasks.get(agent_session_id)

    # running 분기 — intervention queue 큐잉
    if existing and existing.status == TaskStatus.RUNNING:
        intervention_context_items = (
            (params.context_items or [])
            + (params.extra_context_items or [])
        )
        message = {
            "text": params.prompt,
            "user": params.user,
            "attachment_paths": params.attachment_paths or [],
            "caller_info": params.caller_info,
            "context_items": intervention_context_items,
        }
        await existing.intervention_queue.put(message)
        return SubmitMessageResult(
            kind="intervened",
            agent_session_id=agent_session_id,
            task=existing,
            queue_position=existing.intervention_queue.qsize(),
        )

    # terminal 분기 또는 eviction reload 필요
    if not existing:
        # 퇴거된 세션 on-demand 로드 (add_intervention과 동일 패턴)
        existing = await task_manager._eviction_manager.load_evicted_task(
            task_manager._db, agent_session_id
        )
        if not existing:
            if not params.allow_new_session_with_id:
                raise TaskNotFoundError(f"Session not found: {agent_session_id}")
            task = await task_manager.create_task(
                CreateTaskParams(
                    prompt=params.prompt,
                    agent_session_id=agent_session_id,
                    client_id=params.client_id or params.user,
                    allowed_tools=params.allowed_tools,
                    disallowed_tools=params.disallowed_tools,
                    use_mcp=params.use_mcp,
                    context=params.context,
                    context_items=params.context_items,
                    extra_context_items=params.extra_context_items,
                    model=params.model,
                    folder_id=params.folder_id,
                    system_prompt=params.system_prompt,
                    profile_id=params.profile_id,
                    oauth_token=params.oauth_token,
                    caller_session_id=params.caller_session_id,
                    caller_info=params.caller_info,
                    attachment_paths=params.attachment_paths,
                    skip_claude_resume=False,
                )
            )
            return SubmitMessageResult(
                kind="new_session",
                agent_session_id=task.agent_session_id,
                task=task,
            )
        # 방어 코드: startup 처리 누락이나 race로 RUNNING이 남았을 경우 INTERRUPTED 강제
        if existing.status == TaskStatus.RUNNING:
            existing.status = TaskStatus.INTERRUPTED
            await task_manager._db.update_session_status(
                agent_session_id, TaskStatus.INTERRUPTED.value
            )

    # terminal → auto-resume. 일반 resume은 기존 Claude 세션을 이어야 한다.
    extra_ctx = (
        build_attachment_context_items(params.attachment_paths)
        if params.attachment_paths
        else params.extra_context_items
    )
    # 카드 5RcnygV5: terminal 재개 시 사용자가 지정한 옵션(model/allowed_tools/use_mcp 등)을
    # forward한다. _resume_existing_task_locked L211-218이 이 필드들을 *무조건* 덮어쓰므로,
    # SubmitMessageParams에 명시된 값을 넘기지 않으면 task 옵션이 None으로 reset된다.
    # 사용자가 model을 지정해 새 세션을 만들고 limit 후 후속 메시지를 보내면 default model로
    # 폴백되는 결함 차단.
    task = await task_manager.create_task(
        CreateTaskParams(
            prompt=params.prompt,
            agent_session_id=agent_session_id,
            client_id=params.client_id or params.user,
            allowed_tools=params.allowed_tools,
            disallowed_tools=params.disallowed_tools,
            use_mcp=params.use_mcp,
            context=params.context,
            context_items=params.context_items,
            extra_context_items=extra_ctx,
            model=params.model,
            folder_id=params.folder_id,
            system_prompt=params.system_prompt,
            profile_id=params.profile_id,
            attachment_paths=params.attachment_paths,
            caller_info=params.caller_info,
            oauth_token=params.oauth_token,
            skip_claude_resume=False,
        )
    )
    return SubmitMessageResult(
        kind="auto_resumed",
        agent_session_id=agent_session_id,
        task=task,
    )
