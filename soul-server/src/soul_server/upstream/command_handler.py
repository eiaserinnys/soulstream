"""CommandDispatcher — orch-server에서 들어오는 WS 명령을 핸들러로 dispatch.

UpstreamAdapter에서 분리된 명령 처리 도메인 컴포넌트:
- match/case 분기 → ``dict[str, handler]`` dispatch 테이블로 단일화
- atom c13f7826(send_X requestId 키 충돌) / f73e3d60(_handle_X ACK 누락) 안전망
- 신규 명령 추가는 dispatch 테이블 + 메서드 한 곳에만 추가하면 됨

설계 원칙:
- adapter는 인스턴스를 생성하여 composition으로 보유
- task_manager/soul_engine/resource_manager/event_relay는 DI로 주입
- send_fn/send_error_fn/stream_tasks는 reference 공유 (adapter와 동기화)
- ``_handle_*`` 메서드는 dispatch 테이블의 핸들러로 그대로 유지
- 모든 핸들러 예외는 dispatch 루프에서 일괄 catch → ``send_error_fn`` 호출
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Awaitable, Callable

from soul_server.upstream.claude_auth_handlers import (
    ANTHROPIC_PROFILE_URL,
    ANTHROPIC_USAGE_URL,
    handle_auth_api_request,
    handle_auth_delete_token,
    handle_auth_set_token,
    handle_auth_status,
)

from .protocol import (
    CMD_CLAUDE_AUTH_DELETE_TOKEN,
    CMD_CLAUDE_AUTH_GET_PROFILE,
    CMD_CLAUDE_AUTH_GET_USAGE,
    CMD_CLAUDE_AUTH_SET_TOKEN,
    CMD_CLAUDE_AUTH_STATUS,
    CMD_CREATE_SESSION,
    CMD_DELETE_SESSION_ATTACHMENTS,
    CMD_DOWNLOAD_ATTACHMENT,
    CMD_HEALTH_CHECK,
    CMD_INTERVENE,
    CMD_LIST_SESSIONS,
    CMD_RESPOND,
    CMD_SUBSCRIBE_EVENTS,
    CMD_UPLOAD_ATTACHMENT,
    EVT_HEALTH_STATUS,
    EVT_SESSION_CREATED,
    EVT_SESSIONS_UPDATE,
)

from soul_server.service.session_query_service import get_session_query_service
# NOTE: CreateTaskParams 직접 import 제거 — _handle_create_session이 submit_message 정본을
# 거치도록 변경되어 본 모듈은 CreateTaskParams를 직접 다루지 않는다 (design-principles §3).

# cross-node CMD_CREATE_SESSION 진입점의 task.client_id 정책.
# 카드 FHhqVhlv (PR #69 후속): caller_info.source가 있으면 그것을 사용 ("slack", "agent" 등)
# — 디버깅·로그·이력 추적 시 출처 식별을 위해. 없으면 본 상수로 fallback ("upstream" —
# 식별 가능한 상수). PR #69 P1-1이 inline expression으로 도입한 정책을 본 카드에서
# helper와 상수로 *추출*했다 (동작 변경 없음 — 가독성 + 정책이 한 곳에서만 정의되도록
# design-principles §3).
UPSTREAM_DEFAULT_USER = "upstream"


def _resolve_upstream_user(cmd: dict) -> str:
    """cross-node CMD_CREATE_SESSION 명령의 task.client_id에 사용할 user 값을 결정.

    **본 helper는 _handle_create_session 전용**이다 (`task.client_id` = 영구 식별).
    `_handle_intervene`은 `cmd["user"]`를 직접 사용 (sender label) — 정책이 다르므로
    helper 미적용. design-principles §9 (대칭성) 검토 시 의식적 비대칭으로 분류.

    정책 (카드 FHhqVhlv):
    1. cmd["caller_info"]가 dict이고 "source"가 truthy이면 그 값을 사용 (예: "slack", "agent").
       — 발신자 식별·디버깅·세션 이력 추적용.
    2. 그 외 (caller_info 없거나 source 누락) → UPSTREAM_DEFAULT_USER ("upstream") fallback.

    PR #69 P1-1이 inline expression으로 같은 정책을 도입한 것을 본 카드에서 *추출*했다 —
    동작 변경 0, 가독성·정책 단일 정의를 위함.
    """
    caller_info = cmd.get("caller_info")
    if isinstance(caller_info, dict):
        source = caller_info.get("source")
        if source:
            return source
    return UPSTREAM_DEFAULT_USER


if TYPE_CHECKING:
    from soul_server.service.engine_adapter import SoulEngineAdapter
    from soul_server.service.resource_manager import ResourceManager
    from soul_server.service.task_manager import TaskManager

    from .event_relay import EventRelay

logger = logging.getLogger(__name__)


class CommandDispatcher:
    """orch-server WS 명령을 dispatch 테이블로 처리.

    명령 추가 절차:
    1. ``protocol.py``에 ``CMD_*`` 상수 추가
    2. 본 클래스에 ``_handle_*`` 메서드 추가
    3. ``__init__`` 내 ``self._handlers`` 매핑에 등록

    ACK 송신 규칙(atom f73e3d60): 도메인 작업 후 ``requestId``가 있으면
    ``{type: "{cmd}_ack", requestId, status: "ok"}`` 형식으로 ACK 전송.
    누락 시 orch-server ``_send_command`` future가 30초 타임아웃에 걸린다.
    """

    def __init__(
        self,
        *,
        task_manager: "TaskManager",
        soul_engine: "SoulEngineAdapter",
        resource_manager: "ResourceManager",
        node_id: str,
        send_fn: Callable[[dict], Awaitable[None]],
        send_error_fn: Callable[..., Awaitable[None]],
        stream_tasks: dict[str, asyncio.Task],
        event_relay: "EventRelay",
    ) -> None:
        self._tm = task_manager
        self._engine = soul_engine
        self._rm = resource_manager
        self._node_id = node_id
        self._send = send_fn
        self._send_error = send_error_fn
        self._stream_tasks = stream_tasks
        self._relay = event_relay

        # dispatch 테이블 — 명령 추가 시 여기에 등록
        self._handlers: dict[str, Callable[[dict], Awaitable[None]]] = {
            CMD_CREATE_SESSION: self._handle_create_session,
            CMD_INTERVENE: self._handle_intervene,
            CMD_RESPOND: self._handle_respond,
            CMD_LIST_SESSIONS: self._handle_list_sessions,
            CMD_HEALTH_CHECK: self._handle_health_check,
            CMD_SUBSCRIBE_EVENTS: self._handle_subscribe_events,
            CMD_CLAUDE_AUTH_STATUS: self._handle_claude_auth_status,
            CMD_CLAUDE_AUTH_SET_TOKEN: self._handle_claude_auth_set_token,
            CMD_CLAUDE_AUTH_DELETE_TOKEN: self._handle_claude_auth_delete_token,
            CMD_CLAUDE_AUTH_GET_USAGE: self._handle_claude_auth_get_usage,
            CMD_CLAUDE_AUTH_GET_PROFILE: self._handle_claude_auth_get_profile,
            CMD_UPLOAD_ATTACHMENT: self._handle_upload_attachment,
            CMD_DELETE_SESSION_ATTACHMENTS: self._handle_delete_session_attachments,
            CMD_DOWNLOAD_ATTACHMENT: self._handle_download_attachment,
        }

        # 백그라운드 핸들러 — dispatch 루프를 블록하지 않도록 asyncio.create_task로 분리.
        # subscribe_events는 relay_events()를 await하므로 세션 종료까지 블록되어
        # 같은 시간에 들어오는 다른 명령(create/intervene/respond/health)이 처리되지 않는다.
        # 이를 회피하기 위한 분리 (atom c13f7826/f73e3d60 안전망 강화 의도와 정합).
        self._background_handlers: set[str] = {CMD_SUBSCRIBE_EVENTS}

    async def dispatch(self, cmd: dict) -> None:
        """WS 명령을 dispatch 테이블로 라우팅.

        Unknown 명령 또는 핸들러 예외는 일괄 ``send_error`` 처리.
        ``_background_handlers``에 속한 명령은 ``asyncio.create_task``로 분리되어
        dispatch loop를 블록하지 않는다.
        """
        cmd_type = cmd.get("type", "")
        request_id = cmd.get("requestId", "")

        handler = self._handlers.get(cmd_type)
        if handler is None:
            await self._send_error(
                f"Unknown command type: {cmd_type}",
                request_id=request_id,
                command_type=cmd_type,
            )
            return

        # 백그라운드 핸들러 — 직접 await하지 않고 create_task로 분리
        if cmd_type in self._background_handlers:
            session_id = cmd.get("agentSessionId") or cmd.get("session_id", "")
            # 기존 stream task를 cancel — _handle_subscribe_events 본문에서 하던 일을
            # 진입 단계로 끌어올려 self-cancel(dispatch loop가 자기 자신을 await) 위험을 차단.
            old_task = self._stream_tasks.get(session_id)
            if old_task and not old_task.done():
                old_task.cancel()
            task = asyncio.create_task(
                self._dispatch_with_error_capture(handler, cmd),
                name=f"upstream-{cmd_type}-{session_id}",
            )
            self._stream_tasks[session_id] = task
            return

        await self._dispatch_with_error_capture(handler, cmd)

    async def _dispatch_with_error_capture(
        self,
        handler: Callable[[dict], Awaitable[None]],
        cmd: dict,
    ) -> None:
        """핸들러 실행 + 일괄 예외 처리. dispatch와 background 양쪽에서 공유."""
        cmd_type = cmd.get("type", "")
        request_id = cmd.get("requestId", "")
        try:
            await handler(cmd)
        except asyncio.CancelledError:
            # 백그라운드 핸들러가 cancel될 때(예: 재구독으로 이전 task 취소) 정상 흐름.
            raise
        except Exception as e:
            logger.exception("Error handling command %s", cmd_type)
            await self._send_error(
                str(e),
                request_id=request_id,
                command_type=cmd_type,
            )

    # ─── Session lifecycle commands ───────────────────

    async def _handle_create_session(self, cmd: dict) -> None:
        """세션 생성 명령 처리.

        submit_message 정본(design-principles §3)을 거쳐 신규/running/terminal 3분기를 처리한다.
        cross-node CMD_CREATE_SESSION이 *terminal 세션*에 대해 들어오는 경우(resume 시나리오)도
        /execute·/intervene·/api/sessions 세 라우트와 같은 정본을 거친다. 일반 resume은
        기존 Claude 세션을 이어야 하므로 submit_message의 terminal 분기는 resume_session_id를 보존한다.
        """
        # 함수 내부 import — 순환 import 회피 (다른 라우트 어댑터와 동일 패턴)
        from soul_server.service.message_submission_service import (
            SubmitMessageParams,
            submit_message,
        )

        try:
            submit_result = await submit_message(
                SubmitMessageParams(
                    prompt=cmd["prompt"],
                    agent_session_id=cmd.get("agentSessionId"),
                    user=_resolve_upstream_user(cmd),
                    allowed_tools=cmd.get("allowedTools"),
                    disallowed_tools=cmd.get("disallowedTools"),
                    use_mcp=cmd.get("use_mcp") if cmd.get("use_mcp") is not None else cmd.get("useMcp", True),
                    context=cmd.get("context"),
                    context_items=cmd.get("context_items"),
                    extra_context_items=cmd.get("extra_context_items"),
                    profile_id=cmd.get("profile"),
                    folder_id=cmd.get("folderId"),
                    system_prompt=cmd.get("systemPrompt"),
                    oauth_token=cmd.get("oauth_token"),
                    caller_session_id=cmd.get("caller_session_id"),
                    caller_info=cmd.get("caller_info"),
                    model=cmd.get("model"),
                    allow_new_session_with_id=True,
                ),
                task_manager=self._tm,
            )
        except ValueError as e:
            await self._send_error(str(e), request_id=cmd.get("requestId", ""))
            return
        session_id = submit_result.agent_session_id

        # start_execution은 신규/auto_resumed 케이스에서만 호출.
        # intervened(running 세션 큐잉)는 이미 실행 중이므로 새 실행을 시작하지 않는다 (race 차단).
        if submit_result.kind in ("new_session", "auto_resumed"):
            await self._tm.executor.start_execution(
                agent_session_id=session_id,
                claude_runner=self._engine,
                resource_manager=self._rm,
            )

        # 이벤트 스트리밍 시작
        stream_task = asyncio.create_task(
            self._relay.stream_events(session_id),
            name=f"upstream-stream-{session_id}",
        )
        self._stream_tasks[session_id] = stream_task

        # 세션 생성 응답 — requestId가 있을 때만 송신 (atom c13f7826: 빈 string ACK 금지).
        # main의 ACK 가드와 동일 패턴 — _handle_intervene/_handle_respond와 대칭.
        request_id = cmd.get("requestId", "")
        if request_id:
            await self._send({
                "type": EVT_SESSION_CREATED,
                "agentSessionId": session_id,
                "requestId": request_id,
            })

    async def _handle_intervene(self, cmd: dict) -> None:
        """개입 명령 처리.

        F-9 fix(2026-05-08): cmd["caller_info"]를 add_intervention에 전달하여
        2차+ 메시지의 발신자 신원이 InterventionSentEvent까지 운반되도록 한다.
        cmd["caller_info"]가 없으면 None으로 전달 (graceful — 기존 동작 보존).
        """
        session_id = cmd.get("agentSessionId") or cmd.get("session_id", "")
        result = await self._tm.add_intervention(
            agent_session_id=session_id,
            text=cmd["text"],
            user=cmd.get("user", "upstream"),
            attachment_paths=cmd.get("attachment_paths") or None,
            caller_info=cmd.get("caller_info") or None,
        )

        # 오케스트레이터에 ACK 전송 — requestId가 있어야 Future.set_result()가 실행된다.
        # 없으면 오케스트레이터가 30초 타임아웃 후 TimeoutError를 낸다.
        request_id = cmd.get("requestId", "")
        if request_id:
            await self._send({
                "type": "intervene_ack",
                "requestId": request_id,
                "status": "ok",
            })

        # auto-resume 시 실행 재시작
        if result.get("auto_resumed"):
            await self._tm.executor.start_execution(
                agent_session_id=session_id,
                claude_runner=self._engine,
                resource_manager=self._rm,
            )
            # 이벤트 스트리밍이 없으면 시작
            if session_id not in self._stream_tasks or self._stream_tasks[session_id].done():
                stream_task = asyncio.create_task(
                    self._relay.stream_events(session_id),
                    name=f"upstream-stream-{session_id}",
                )
                self._stream_tasks[session_id] = stream_task

    async def _handle_respond(self, cmd: dict) -> None:
        """AskUserQuestion 응답 처리.

        cmd['requestId']는 WS 명령 ID(orch-server _send_command가 Future 매칭에 사용).
        cmd['inputRequestId']는 input_request의 request_id (deliver_input_response 인자).
        구버전 호환을 위해 'request_id' snake_case도 fallback으로 받는다.

        ACK 누락 시 orch-server _send_command가 30초 타임아웃에 걸린다.
        동일 ACK 패턴: _handle_intervene.
        """
        self._tm.deliver_input_response(
            agent_session_id=cmd.get("agentSessionId") or cmd.get("session_id", ""),
            request_id=(
                cmd.get("inputRequestId")
                or cmd.get("request_id", "")
            ),
            answers=cmd["answers"],
        )

        # 오케스트레이터에 ACK — requestId가 있어야 Future.set_result()가 실행된다.
        request_id = cmd.get("requestId", "")
        if request_id:
            await self._send({
                "type": "respond_ack",
                "requestId": request_id,
                "status": "ok",
            })

    async def _handle_list_sessions(self, cmd: dict) -> None:
        """세션 목록 반환."""
        sessions, total = await get_session_query_service().get_all_sessions()
        await self._send({
            "type": EVT_SESSIONS_UPDATE,
            "sessions": sessions,
            "total": total,
            "requestId": cmd.get("requestId", ""),
        })

    async def _handle_health_check(self, cmd: dict) -> None:
        """헬스체크 응답."""
        stats = self._rm.get_stats()
        await self._send({
            "type": EVT_HEALTH_STATUS,
            "runners": stats,
            "node_id": self._node_id,
            "requestId": cmd.get("requestId", ""),
        })

    async def _handle_subscribe_events(self, cmd: dict) -> None:
        """subscribe_events 명령 처리: 라이브 이벤트 relay.

        DB 재생은 sessions.py(soulstream-server)가 이미 수행하므로 생략하고
        라이브 이벤트만 relay한다.

        ``dispatch`` 진입 단계에서 이미 (1) 기존 stream task cancel, (2) 새 task로
        본 핸들러를 ``asyncio.create_task``로 띄우고 ``_stream_tasks[session_id]``에 등록.
        따라서 본문은 단순히 ``relay_events``를 await하면 된다.
        ``relay_events``의 finally가 자기-task 일치 시 stream_tasks에서 제거.
        """
        session_id = cmd.get("agentSessionId") or cmd.get("session_id", "")
        if not session_id:
            return
        await self._relay.relay_events(session_id)

    # ─── Claude OAuth commands ────────────────────────

    async def _handle_claude_auth_status(self, cmd: dict) -> None:
        request_id = cmd.get("requestId", "")
        await self._send(handle_auth_status(request_id, CMD_CLAUDE_AUTH_STATUS))

    async def _handle_claude_auth_set_token(self, cmd: dict) -> None:
        request_id = cmd.get("requestId", "")
        resp, err = handle_auth_set_token(cmd, request_id, CMD_CLAUDE_AUTH_SET_TOKEN)
        if err:
            await self._send_error(
                err, request_id=request_id, command_type=CMD_CLAUDE_AUTH_SET_TOKEN,
            )
        else:
            await self._send(resp)

    async def _handle_claude_auth_delete_token(self, cmd: dict) -> None:
        request_id = cmd.get("requestId", "")
        await self._send(handle_auth_delete_token(request_id, CMD_CLAUDE_AUTH_DELETE_TOKEN))

    async def _handle_claude_auth_get_usage(self, cmd: dict) -> None:
        request_id = cmd.get("requestId", "")
        await self._send(await handle_auth_api_request(
            request_id, CMD_CLAUDE_AUTH_GET_USAGE, ANTHROPIC_USAGE_URL,
        ))

    async def _handle_claude_auth_get_profile(self, cmd: dict) -> None:
        request_id = cmd.get("requestId", "")
        await self._send(await handle_auth_api_request(
            request_id, CMD_CLAUDE_AUTH_GET_PROFILE, ANTHROPIC_PROFILE_URL,
        ))

    # ─── Attachment WS reverse-proxy handlers ────────────
    # 노드 self-reported host:port HTTP 가정 폐기 — orch가 WS로 attachment binary를
    # base64-in-JSON으로 전달한다. 운영 로그(eias-shopping host=127.0.0.1)에서 cross-node
    # HTTP가 도달 불가했던 결함 회로 차단. orch 측 4xx 분류용 wire 약속:
    #   - INVALID_REQUEST: prefix → 400 (file_manager 검증 실패 / base64 디코딩 실패)
    #   - 그 외 RuntimeError → 502 (노드 내부 에러)
    #   - TimeoutError (orch 측) → 504

    async def _handle_upload_attachment(self, cmd: dict) -> None:
        """WS 경유 cross-node 첨부 업로드.

        payload: {session_id, filename, content_type, content_b64}
        응답: {type:"upload_attachment_result", requestId, path, filename, size, content_type}
        """
        import base64
        from soul_server.service import file_manager, AttachmentError

        request_id = cmd.get("requestId", "")
        try:
            # validate=True — invalid base64 문자는 명시적으로 실패한다.
            # 기본값 False는 garbage 입력을 silently 무시하여 silent corruption 위험.
            content = base64.b64decode(cmd["content_b64"], validate=True)
        except KeyError:
            await self._send_error(
                "INVALID_REQUEST: content_b64 누락",
                request_id=request_id,
                command_type=CMD_UPLOAD_ATTACHMENT,
            )
            return
        except Exception as e:
            await self._send_error(
                f"INVALID_REQUEST: base64 디코딩 실패: {e}",
                request_id=request_id,
                command_type=CMD_UPLOAD_ATTACHMENT,
            )
            return

        try:
            result = await file_manager.save_file_for_session(
                filename=cmd.get("filename") or "unnamed",
                content=content,
                session_id=cmd["session_id"],
            )
        except KeyError:
            await self._send_error(
                "INVALID_REQUEST: session_id 누락",
                request_id=request_id,
                command_type=CMD_UPLOAD_ATTACHMENT,
            )
            return
        except AttachmentError as e:
            # file_manager의 사이즈/확장자 검증 실패 — orch가 400으로 분류
            await self._send_error(
                f"INVALID_REQUEST: {e}",
                request_id=request_id,
                command_type=CMD_UPLOAD_ATTACHMENT,
            )
            return

        if request_id:
            await self._send({
                "type": "upload_attachment_result",
                "requestId": request_id,
                "path": result["path"],
                "filename": result["filename"],
                "size": result["size"],
                "content_type": result["content_type"],
            })

    async def _handle_delete_session_attachments(self, cmd: dict) -> None:
        """WS 경유 세션 첨부 정리.

        payload: {session_id}
        응답: {type:"delete_session_attachments_result", requestId, cleaned, files_removed}

        cleanup_session은 동기 함수지만 기존 HTTP 라우트(api/attachments.py:149)도
        `async def` 안에서 동일하게 동기 호출하므로 일관성 우선 — 동기 호출 그대로
        (design-principles §9). 대용량 cleanup이 문제되면 후속 카드에서 run_in_executor.
        """
        from soul_server.service import file_manager

        request_id = cmd.get("requestId", "")
        try:
            files_removed = file_manager.cleanup_session(cmd["session_id"])
        except KeyError:
            await self._send_error(
                "INVALID_REQUEST: session_id 누락",
                request_id=request_id,
                command_type=CMD_DELETE_SESSION_ATTACHMENTS,
            )
            return

        if request_id:
            await self._send({
                "type": "delete_session_attachments_result",
                "requestId": request_id,
                "cleaned": True,
                "files_removed": files_removed,
            })

    async def _handle_download_attachment(self, cmd: dict) -> None:
        """WS 경유 cross-node 첨부 다운로드 (Phase 2 — 채팅 인라인 표시).

        payload: {path: str (노드 절대경로)}
        응답: {type:"download_attachment_result", requestId, content_b64,
               content_type, filename, size}
        실패:
          - 경로 누락/형식 오류: INVALID_REQUEST: prefix → orch 400
          - file_manager 하위 아님(directory traversal): INVALID_REQUEST: → 400
          - 파일 미존재: NOT_FOUND: prefix → orch 404
          - 읽기 실패 etc: dispatch loop 일반 catch → 502

        보안: file_manager.is_under_base()로 base_dir 하위 path만 허용.
        symlink는 resolve된 목적지가 base_dir 하위인지로 판정.
        """
        import base64
        import mimetypes
        from pathlib import Path

        from soul_server.service import file_manager

        request_id = cmd.get("requestId", "")
        raw_path = cmd.get("path")
        if not isinstance(raw_path, str) or not raw_path:
            await self._send_error(
                "INVALID_REQUEST: path 누락 또는 빈 문자열",
                request_id=request_id,
                command_type=CMD_DOWNLOAD_ATTACHMENT,
            )
            return

        try:
            target = Path(raw_path)
        except (TypeError, ValueError) as e:
            await self._send_error(
                f"INVALID_REQUEST: 잘못된 경로 형식: {e}",
                request_id=request_id,
                command_type=CMD_DOWNLOAD_ATTACHMENT,
            )
            return

        # directory traversal 가드 — file_manager의 공개 메서드 사용 (private
        # `_base_dir` 직접 접근 금지, design-principles §1·§10).
        if not file_manager.is_under_base(target):
            await self._send_error(
                "INVALID_REQUEST: path가 첨부 디렉토리 하위가 아닙니다",
                request_id=request_id,
                command_type=CMD_DOWNLOAD_ATTACHMENT,
            )
            return

        # is_under_base는 resolve된 경로가 base 하위임을 확인했지만, 실제
        # 파일 존재 여부는 별도 검증.
        resolved = target.resolve()
        if not resolved.is_file():
            await self._send_error(
                "NOT_FOUND: 파일이 존재하지 않습니다",
                request_id=request_id,
                command_type=CMD_DOWNLOAD_ATTACHMENT,
            )
            return

        content = resolved.read_bytes()
        content_type = (
            mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
        )

        if request_id:
            await self._send({
                "type": "download_attachment_result",
                "requestId": request_id,
                "content_b64": base64.b64encode(content).decode("ascii"),
                "content_type": content_type,
                "filename": resolved.name,
                "size": len(content),
            })
