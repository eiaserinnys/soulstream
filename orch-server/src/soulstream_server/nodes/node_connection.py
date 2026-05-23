"""NodeConnection — soul-server node WebSocket connection wrapper."""

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect

from soulstream_server.constants import (
    CMD_APPROVE_TOOL,
    CMD_CREATE_SESSION,
    CMD_DELETE_SESSION_ATTACHMENTS,
    CMD_DOWNLOAD_ATTACHMENT,
    CMD_INTERVENE,
    CMD_INTERRUPT_SESSION,
    CMD_REALTIME_CREATE_CALL,
    CMD_REALTIME_EVENT,
    CMD_REALTIME_RESOLVE_TOOL_APPROVAL,
    CMD_REJECT_TOOL,
    CMD_RESPOND,
    CMD_SUBSCRIBE_EVENTS,
    CMD_UPLOAD_ATTACHMENT,
    CMD_CLAUDE_AUTH_STATUS,
    CMD_CLAUDE_AUTH_SET_TOKEN,
    CMD_CLAUDE_AUTH_DELETE_TOKEN,
    CMD_CLAUDE_AUTH_GET_USAGE,
    CMD_CLAUDE_AUTH_GET_PROFILE,
    CMD_PROVIDER_USAGE_GET,
    COMMAND_TIMEOUT,
    EVT_ERROR,
)
from soulstream_server.nodes.inbound_events import (
    NodeInboundEvents,
    OnSessionChangeCallback,
)
from soulstream_server.nodes.pending_commands import PendingCommands

OnCloseCallback = Callable[["NodeConnection"], Coroutine[Any, Any, None]]


class NodeConnection:
    """soul-server 노드 하나의 WebSocket 연결."""

    def __init__(
        self,
        ws: WebSocket,
        node_id: str,
        host: str = "",
        port: int = 0,
        capabilities: dict | None = None,
        supported_backends: list[str] | None = None,
        on_close: OnCloseCallback | None = None,
        on_session_change: OnSessionChangeCallback | None = None,
    ):
        self._ws = ws
        self.node_id = node_id
        self.host = host
        self.port = port
        # 옵션 D Phase A: capabilities 타입을 dict로 정정 (실제 wire는 dict — adapter._build_registration_msg
        # `{"max_concurrent": ...}` 형태). 기존 호출자가 list를 넘기면 그대로 저장 (런타임 강제 없음).
        self.capabilities = capabilities or {}
        # 옵션 D Phase A: 노드가 지원하는 백엔드 목록. 미명시 시 ["claude"] (후방호환).
        # SessionRouter가 agent.backend ↔ node.supported_backends 매칭 필터로 라우팅.
        self.supported_backends = (
            supported_backends if supported_backends is not None else ["claude"]
        )
        self.connected_at = datetime.now(timezone.utc)

        self._agent_profiles: dict = {}  # 연결 직후 _fetch_agent_profiles()로 populate됨
        self._portrait_cache: dict[str, bytes] = {}  # agent_id → portrait bytes (등록 메시지에서 수신)
        self._user_info: dict = {}  # 연결 직후 _fetch_user_info()로 populate됨
        self._pending_commands = PendingCommands()
        self._pending = self._pending_commands.pending
        self._inbound_events = NodeInboundEvents(
            node_id=node_id,
            on_session_change=on_session_change,
        )
        self._sessions = self._inbound_events.sessions
        self._subscribe_listeners = self._inbound_events.subscribe_listeners

        self.on_close = on_close

    @property
    def sessions(self) -> dict[str, dict]:
        return self._sessions

    @property
    def agent_profiles(self) -> dict:
        return self._agent_profiles

    @property
    def portrait_cache(self) -> dict[str, bytes]:
        return self._portrait_cache

    def set_agent_data(
        self, profiles: dict, portrait_cache: dict[str, bytes]
    ) -> None:
        """에이전트 프로필과 portrait 캐시를 설정한다."""
        self._agent_profiles = profiles
        self._portrait_cache = portrait_cache

    @property
    def user_info(self) -> dict:
        return self._user_info

    def set_user_info(self, user_info: dict) -> None:
        """사용자 정보를 설정한다."""
        self._user_info = user_info

    @property
    def on_session_change(self) -> OnSessionChangeCallback | None:
        return self._inbound_events.on_session_change

    @on_session_change.setter
    def on_session_change(
        self, callback: OnSessionChangeCallback | None
    ) -> None:
        self._inbound_events.on_session_change = callback

    @property
    def session_count(self) -> int:
        return len(self._sessions)

    @property
    def _closed(self) -> bool:
        return self._pending_commands.closed

    def to_info(self) -> dict:
        return {
            "nodeId": self.node_id,
            "host": self.host,
            "port": self.port,
            "capabilities": self.capabilities,
            # 옵션 D Phase A: 노드 supported_backends를 API/SSE wire에 운반.
            "supportedBackends": self.supported_backends,
            "connectedAt": self.connected_at.isoformat(),
            "sessionCount": self.session_count,
            "status": "connected",
        }

    def _next_request_id(self) -> str:
        return self._pending_commands.next_request_id()

    async def _send(self, data: dict) -> None:
        try:
            await self._ws.send_json(data)
        except Exception as e:
            # websockets 라이브러리가 close frame 이후 send를 시도하면
            # "Cannot call 'send' once a close message has been sent." RuntimeError를 발생시킨다.
            # 이를 WebSocketDisconnect로 정규화하여 호출자가 일관되게 처리할 수 있게 한다.
            raise WebSocketDisconnect(code=1011, reason=str(e)) from e

    async def _send_command(
        self, command: str, payload: dict, timeout: float = COMMAND_TIMEOUT
    ) -> dict:
        request_id = self._next_request_id()
        future = self._pending_commands.register(request_id)

        message = {"type": command, "requestId": request_id, **payload}
        try:
            await self._send(message)
        except WebSocketDisconnect as e:
            self._pending_commands.discard(request_id)
            # 노드가 connection 끊긴 상태에서 send 시도 — 호출자가 503으로 분류 가능하도록
            # ConnectionError로 정규화 (RuntimeError에 흡수되지 않게).
            raise ConnectionError(
                f"Node disconnected before send: command={command} ({e})"
            ) from e

        return await self._pending_commands.wait_for_result(
            request_id,
            command=command,
            future=future,
            timeout=timeout,
        )

    async def send_create_session(
        self,
        prompt: str,
        session_id: str | None = None,
        profile: str | None = None,
        allowed_tools: list[str] | None = None,
        disallowed_tools: list[str] | None = None,
        use_mcp: bool | None = None,
        folder_id: str | None = None,
        system_prompt: str | None = None,
        oauth_profile_name: str | None = None,
        caller_session_id: str | None = None,
        attachment_paths: list[str] | None = None,
        caller_info: dict | None = None,
        model: str | None = None,
        reasoning_effort: str | None = None,
        extra_context_items: list[dict] | None = None,
    ) -> dict:
        payload: dict[str, Any] = {"prompt": prompt}
        if session_id:
            payload["agentSessionId"] = session_id
        if profile:
            payload["profile"] = profile
        if allowed_tools is not None:
            payload["allowedTools"] = allowed_tools
        if disallowed_tools is not None:
            payload["disallowedTools"] = disallowed_tools
        if use_mcp is not None:
            payload["useMcp"] = use_mcp
        if folder_id is not None:
            payload["folderId"] = folder_id
        if system_prompt is not None:
            payload["systemPrompt"] = system_prompt
        if oauth_profile_name is not None:
            payload["oauth_profile_name"] = oauth_profile_name
        if caller_session_id is not None:
            payload["caller_session_id"] = caller_session_id
        if caller_info is not None:
            payload["caller_info"] = caller_info
        if extra_context_items:
            # 호출자가 직접 extra_context_items를 제공한 경우 그대로 전달
            payload["extra_context_items"] = extra_context_items
        elif attachment_paths:
            # soul-server upstream/adapter.py가 extra_context_items=cmd.get("extra_context_items")로
            # 처리하므로 여기서 변환한다. adapter.py 수정 불필요 (create_session 경로).
            # 변환 책임은 soul-server WS 프로토콜을 아는 node_connection.py에 있다.
            payload["extra_context_items"] = [{
                "key": "attached_files",
                "label": "첨부 파일",
                "content": (
                    "다음 파일들이 첨부되었습니다. Read 도구로 내용을 확인하세요:\n"
                    + "\n".join(f"- {p}" for p in attachment_paths)
                ),
            }]
        if model is not None:
            payload["model"] = model
        if reasoning_effort is not None:
            payload["reasoningEffort"] = reasoning_effort
        return await self._send_command(CMD_CREATE_SESSION, payload)

    async def send_intervene(
        self,
        session_id: str,
        text: str,
        user: str = "",
        attachment_paths: list[str] | None = None,
        caller_info: dict | None = None,
    ) -> dict:
        payload: dict[str, Any] = {"agentSessionId": session_id, "text": text, "user": user}
        if attachment_paths:
            # soul-server adapter.py _handle_intervene이 cmd.get("attachment_paths")로 처리한다.
            # (Phase 1에서 _handle_intervene에 attachment_paths 지원이 추가됨)
            payload["attachment_paths"] = attachment_paths
        if caller_info:
            # F-9 fix(2026-05-08): 2차+ 메시지의 발신자 신원을 wire 끝까지 운반.
            # soul-server _handle_intervene이 cmd.get("caller_info")로 추출하여
            # add_intervention → 큐 → InterventionSentEvent.caller_info로 전파한다.
            payload["caller_info"] = caller_info
        return await self._send_command(CMD_INTERVENE, payload)

    async def send_interrupt_session(self, session_id: str) -> dict:
        """진행 중인 세션 turn을 즉시 중단한다."""
        return await self._send_command(
            CMD_INTERRUPT_SESSION,
            {"agentSessionId": session_id},
        )

    # ─── Attachment WS reverse-proxy ────────────────────
    # 노드 self-reported host:port HTTP 가정 폐기 (운영 로그: eias-shopping host=127.0.0.1)
    # — 모든 cross-node attachment 통신은 본 WS wire로 통합. atom 작업 이력 260513.01.

    async def send_upload_attachment(
        self,
        session_id: str,
        filename: str,
        content_type: str,
        content_b64: str,
    ) -> dict:
        """노드에 attachment 업로드를 WS로 위임.

        binary는 base64로 인코딩하여 텍스트 WS 프레임으로 전송한다(기존 `send_json`
        wire 재사용). 노드 측 수신 한도는 *aiohttp 클라이언트의 `max_msg_size`*
        (soul-server adapter.py에서 `WS_INCOMING_MAX_MSG_SIZE=16MB` 명시 설정)에
        의해 정해지며, MAX_ATTACHMENT_SIZE=8MB → base64 ~10.7MB로 안전. orch
        서버 측 수신 한도는 uvicorn의 `ws_max_size` 기본 16MB이나 본 wire는
        orch → 노드 방향만 큰 페이로드를 가지므로 노드 측 한도가 정본.

        응답: {path, filename, size, content_type} — 노드 디스크의 절대경로.
        """
        payload = {
            "session_id": session_id,
            "filename": filename,
            "content_type": content_type,
            "content_b64": content_b64,
        }
        return await self._send_command(CMD_UPLOAD_ATTACHMENT, payload)

    async def send_delete_session_attachments(self, session_id: str) -> dict:
        """세션 첨부 정리를 WS로 위임.

        응답: {cleaned: bool, files_removed: int}.
        """
        return await self._send_command(
            CMD_DELETE_SESSION_ATTACHMENTS, {"session_id": session_id}
        )

    async def send_download_attachment(self, path: str) -> dict:
        """노드 디스크의 첨부 binary를 base64로 다운로드 (Phase 2 — 채팅 인라인 표시).

        노드 측 file_manager.is_under_base() 검증을 통해 directory traversal
        방지. base 하위가 아니면 INVALID_REQUEST: prefix EVT_ERROR. 파일 없으면
        NOT_FOUND: prefix EVT_ERROR.

        응답: {content_b64, content_type, filename, size}.
        """
        return await self._send_command(
            CMD_DOWNLOAD_ATTACHMENT, {"path": path}
        )

    async def send_claude_auth_status(self) -> dict:
        """Claude Code OAuth 토큰 존재 여부 조회."""
        return await self._send_command(CMD_CLAUDE_AUTH_STATUS, {})

    async def send_claude_auth_set_token(
        self,
        token: str,
        refresh_token: str | None = None,
        expires_in: int | None = None,
        scope: str = "",
    ) -> dict:
        """Claude Code OAuth 토큰 설정."""
        payload: dict = {"token": token}
        if refresh_token is not None:
            payload["refresh_token"] = refresh_token
        if expires_in is not None:
            payload["expires_in"] = expires_in
        if scope:
            payload["scope"] = scope
        return await self._send_command(CMD_CLAUDE_AUTH_SET_TOKEN, payload)

    async def send_claude_auth_delete_token(self) -> dict:
        """Claude Code OAuth 토큰 삭제."""
        return await self._send_command(CMD_CLAUDE_AUTH_DELETE_TOKEN, {})

    async def send_claude_auth_get_usage(self) -> dict:
        """Claude Code OAuth 사용량 조회."""
        return await self._send_command(CMD_CLAUDE_AUTH_GET_USAGE, {})

    async def send_claude_auth_get_profile(self) -> dict:
        """Anthropic 계정 프로필(email 등) 조회."""
        return await self._send_command(CMD_CLAUDE_AUTH_GET_PROFILE, {})

    async def send_provider_usage_get(self, provider: str | None = None) -> dict:
        """Claude/Codex/Gemini OAuth 사용량 조회."""
        payload: dict[str, Any] = {}
        if provider is not None:
            payload["provider"] = provider
        return await self._send_command(CMD_PROVIDER_USAGE_GET, payload)

    async def send_respond(
        self, session_id: str, request_id: str, answers: dict
    ) -> dict:
        """input_request의 request_id는 inputRequestId 별도 키로 보낸다.

        payload에 'requestId'를 포함하면 _send_command line 142의 `{**payload}` spread가
        WS 명령 ID를 덮어쓰는 결함이 발현된다 (_pending 매칭 실패 → 30초 타임아웃).
        """
        return await self._send_command(
            CMD_RESPOND,
            {
                "agentSessionId": session_id,
                "inputRequestId": request_id,
                "answers": answers,
            },
        )

    async def send_tool_approval(
        self,
        session_id: str,
        approval_id: str,
        decision: str,
        message: str | None = None,
        always_approve: bool | None = None,
        always_reject: bool | None = None,
    ) -> dict:
        """OpenAI Agents SDK tool approval 승인/거부를 노드에 전달한다."""
        command = CMD_APPROVE_TOOL if decision == "approved" else CMD_REJECT_TOOL
        payload: dict[str, Any] = {
            "agentSessionId": session_id,
            "approvalId": approval_id,
        }
        if message is not None:
            payload["message"] = message
        if always_approve is not None:
            payload["alwaysApprove"] = always_approve
        if always_reject is not None:
            payload["alwaysReject"] = always_reject
        return await self._send_command(command, payload)

    async def send_realtime_create_call(
        self,
        session_id: str,
        offer_sdp: str,
        model: str | None = None,
        voice: str | None = None,
        instructions: str | None = None,
    ) -> dict:
        """soul-app WebRTC offer를 노드의 OpenAI Realtime broker로 전달한다."""
        payload: dict[str, Any] = {
            "agentSessionId": session_id,
            "offerSdp": offer_sdp,
        }
        if model is not None:
            payload["model"] = model
        if voice is not None:
            payload["voice"] = voice
        if instructions is not None:
            payload["instructions"] = instructions
        return await self._send_command(CMD_REALTIME_CREATE_CALL, payload)

    async def send_realtime_event(
        self,
        session_id: str,
        event: dict,
        call_id: str | None = None,
    ) -> dict:
        """soul-app data-channel event를 노드 persistence/relay 경로로 전달한다."""
        payload: dict[str, Any] = {
            "agentSessionId": session_id,
            "event": event,
        }
        if call_id is not None:
            payload["callId"] = call_id
        return await self._send_command(CMD_REALTIME_EVENT, payload)

    async def send_realtime_tool_approval(
        self,
        session_id: str,
        approval_id: str,
        decision: str,
        message: str | None = None,
        source: str | None = None,
        call_id: str | None = None,
    ) -> dict:
        """Realtime tool approval 결정을 노드에 영속화하고 data-channel 이벤트를 받는다."""
        payload: dict[str, Any] = {
            "agentSessionId": session_id,
            "approvalId": approval_id,
            "decision": decision,
        }
        if message is not None:
            payload["message"] = message
        if source is not None:
            payload["source"] = source
        if call_id is not None:
            payload["callId"] = call_id
        return await self._send_command(CMD_REALTIME_RESOLVE_TOOL_APPROVAL, payload)

    async def send_subscribe_events(
        self, session_id: str, callback: Callable
    ) -> str:
        subscribe_id = str(uuid.uuid4())
        self._inbound_events.register_subscribe_listener(
            session_id, subscribe_id, callback
        )

        try:
            await self._send({
                "type": CMD_SUBSCRIBE_EVENTS,
                "agentSessionId": session_id,
                "subscribeId": subscribe_id,
            })
        except (Exception, asyncio.CancelledError):
            self._inbound_events.unsubscribe_events(session_id, subscribe_id)
            raise
        return subscribe_id

    def unsubscribe_events(self, session_id: str, subscribe_id: str) -> None:
        self._inbound_events.unsubscribe_events(session_id, subscribe_id)

    async def handle_message(self, data: dict) -> None:
        msg_type = data.get("type")
        request_id = data.get("requestId")

        # pending request에 대한 응답
        if request_id and request_id in self._pending:
            if msg_type == EVT_ERROR:
                self._pending_commands.reject(
                    request_id,
                    data.get("message", "Unknown error"),
                )
            else:
                self._pending_commands.resolve(request_id, data)
            return

        await self._inbound_events.handle(data)

    async def close(self) -> None:
        self._pending_commands.cancel_all_for_close()
        self._inbound_events.clear_subscribe_listeners()

        try:
            await self._ws.close()
        except Exception:
            pass

        if self.on_close:
            cb = self.on_close
            self.on_close = None  # 이중 호출 방지 — ws_handler finally와 register_node 중복 호출
            await cb(self)
