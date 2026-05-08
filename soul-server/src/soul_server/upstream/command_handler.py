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
    CMD_HEALTH_CHECK,
    CMD_INTERVENE,
    CMD_LIST_SESSIONS,
    CMD_RESPOND,
    CMD_SUBSCRIBE_EVENTS,
    EVT_HEALTH_STATUS,
    EVT_SESSION_CREATED,
    EVT_SESSIONS_UPDATE,
)

from soul_server.service.session_query_service import get_session_query_service
from soul_server.service.task_factory import CreateTaskParams

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
        """세션 생성 명령 처리."""
        try:
            task = await self._tm.create_task(CreateTaskParams(
                prompt=cmd["prompt"],
                agent_session_id=cmd.get("agentSessionId"),
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
            ))
        except ValueError as e:
            await self._send_error(str(e), request_id=cmd.get("requestId", ""))
            return
        session_id = task.agent_session_id

        # 실행 시작
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
