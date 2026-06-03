"""
Intervention service — intervene/respond 비즈니스 로직 정본 (design-principles §3).

기존에 ``api/tasks.py``의 intervene_session/respond_to_input_request와
``dashboard/routes/sessions.py``의 api_intervene/api_respond에 100% 중복으로 존재하던
로직을 본 모듈로 통합한다. 라우트는 인증·body 변환·HTTPException 매핑만 담당.

DI 패턴: task_manager/soul_engine/resource_manager는 라우트가 조달하여 keyword로 주입.
service는 의존성을 직접 import하지 않는다.
"""

from __future__ import annotations

from typing import Optional


class InputRequestNotPendingError(Exception):
    """AskUserQuestion request_id가 pending이 아닐 때 raise.

    라우트에서 422 Unprocessable Entity로 변환한다.
    """

    def __init__(self, request_id: str):
        self.request_id = request_id
        super().__init__(f"input_request not pending: {request_id}")


async def intervene(
    agent_session_id: str,
    text: str,
    user: str,
    attachment_paths: Optional[list[str]],
    context_items: Optional[list[dict]] = None,
    *,
    task_manager,
    soul_engine,
    resource_manager,
    caller_info: Optional[dict] = None,
) -> dict:
    """세션 개입 메시지 전송 (자동 resume 포함).

    Running 세션이면 intervention queue에 추가. 완료된 세션이면 자동으로 resume하여
    대화를 이어간다 (auto_resumed=True).

    Args:
        agent_session_id: 대상 세션 ID.
        text: 개입 메시지 본문.
        user: 발신자 식별 (사용자 닉네임 등).
        attachment_paths: 첨부 파일 경로 리스트 (None이면 빈 리스트로 정규화).
        context_items: 개입 turn에만 추가할 context items.
        task_manager: TaskManager 인스턴스.
        soul_engine: ClaudeRunner (start_execution용).
        resource_manager: 동시 실행 제한 매니저.
        caller_info: 발신자 신원(통합 v1, atom ed3a216d). F-9 fix(2026-05-08)로
            추가됐다. 큐를 거쳐 InterventionSentEvent.caller_info로 전파되어 2차+
            메시지의 메시지-단위 발신자 표시를 가능하게 한다. 비어있으면 클라이언트는
            세션-단위 metadata로 fallback (graceful).

    Returns:
        - auto_resumed=True 경로: ``{"auto_resumed": True, "agent_session_id": str}``
        - 큐잉 경로:           ``{"queued": True, "queue_position": int}``

    Raises:
        NodeMismatchError — 세션이 다른 노드 소속. 라우트가 403으로 변환.
        TaskNotFoundError — 세션 미존재. 라우트가 404로 변환.
    """
    # 본 함수는 라우트용 진입점이다. 동작 정본은 ``submit_message``(message_submission_service);
    # 본 함수는 ``task_manager.add_intervention``(submit_message의 backward-compat wrapper)을
    # 호출하여 자연스럽게 같은 정본을 거친다. terminal 분기에서도 일반 resume은 기존
    # Claude 세션을 이어간다.
    result = await task_manager.add_intervention(
        agent_session_id=agent_session_id,
        text=text,
        user=user,
        attachment_paths=attachment_paths or [],
        extra_context_items=context_items,
        caller_info=caller_info,
    )
    if result.get("auto_resumed"):
        await task_manager.executor.start_execution(
            agent_session_id=agent_session_id,
            claude_runner=soul_engine,
            resource_manager=resource_manager,
        )
        return {"auto_resumed": True, "agent_session_id": agent_session_id}
    return {"queued": True, "queue_position": result.get("queue_position", 0)}


async def respond_to_input(
    agent_session_id: str,
    request_id: str,
    answers: dict,
    *,
    task_manager,
) -> dict:
    """AskUserQuestion에 대한 사용자 응답 전달.

    ``deliver_input_response``는 sync 함수이므로 내부에서 ``await`` 없이 호출한다.
    service 함수 자체는 ``async def``로 두어 라우트와 인터페이스 일관성을 유지하고
    향후 비동기 전환을 대비한다.

    Args:
        agent_session_id: 대상 세션 ID.
        request_id: input_request SSE 이벤트의 request_id.
        answers: 사용자 답변 (포맷은 task_manager 계층의 명세를 따름).
        task_manager: TaskManager 인스턴스.

    Returns:
        ``{"delivered": True, "request_id": str}``

    Raises:
        TaskNotFoundError — 세션 미존재. 라우트가 404로 변환.
        TaskNotRunningError — 세션 비실행. 라우트가 409로 변환.
        InputRequestNotPendingError — request_id가 pending 상태가 아님. 라우트가 422로 변환.
    """
    success = task_manager.deliver_input_response(
        agent_session_id=agent_session_id,
        request_id=request_id,
        answers=answers,
    )
    if not success:
        raise InputRequestNotPendingError(request_id)
    return {"delivered": True, "request_id": request_id}
