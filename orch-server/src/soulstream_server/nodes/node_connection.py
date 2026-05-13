"""
NodeConnection — soul-server 노드의 WebSocket 연결을 래핑.

노드 정보 추적, 명령 전송, 수신 메시지 디스패치, 응답 대기(Future) 관리.
"""

import asyncio
import json
import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine, Optional

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect

from soulstream_server.constants import (
    CMD_CREATE_SESSION,
    CMD_DELETE_SESSION_ATTACHMENTS,
    CMD_INTERVENE,
    CMD_RESPOND,
    CMD_SUBSCRIBE_EVENTS,
    CMD_UPLOAD_ATTACHMENT,
    CMD_CLAUDE_AUTH_STATUS,
    CMD_CLAUDE_AUTH_SET_TOKEN,
    CMD_CLAUDE_AUTH_DELETE_TOKEN,
    CMD_CLAUDE_AUTH_GET_USAGE,
    CMD_CLAUDE_AUTH_GET_PROFILE,
    COMMAND_TIMEOUT,
    EVT_ERROR,
    EVT_EVENT,
    EVT_HEALTH_STATUS,
    EVT_INPUT_REQUEST,
    EVT_SESSION_CREATED,
    EVT_SESSION_DELETED,
    EVT_SESSION_UPDATED,
    EVT_SESSIONS_UPDATE,
)

logger = logging.getLogger(__name__)

# Callback type aliases
OnCloseCallback = Callable[["NodeConnection"], Coroutine[Any, Any, None]]
OnSessionChangeCallback = Callable[
    [str, str, dict | None], Coroutine[Any, Any, None]
]  # (node_id, change_type, data)


class NodeConnection:
    """soul-server 노드 하나의 WebSocket 연결."""

    def __init__(
        self,
        ws: WebSocket,
        node_id: str,
        host: str = "",
        port: int = 0,
        capabilities: list[str] | None = None,
        on_close: OnCloseCallback | None = None,
        on_session_change: OnSessionChangeCallback | None = None,
    ):
        self._ws = ws
        self.node_id = node_id
        self.host = host
        self.port = port
        self.capabilities = capabilities or []
        self.connected_at = datetime.now(timezone.utc)

        self._sessions: dict[str, dict] = {}
        self._agent_profiles: dict = {}  # 연결 직후 _fetch_agent_profiles()로 populate됨
        self._portrait_cache: dict[str, bytes] = {}  # agent_id → portrait bytes (등록 메시지에서 수신)
        self._user_info: dict = {}  # 연결 직후 _fetch_user_info()로 populate됨
        self._request_counter = 0
        self._pending: dict[str, asyncio.Future] = {}
        self._subscribe_listeners: dict[str, dict[str, Callable]] = {}
        # close() 호출 여부 플래그 — `_send_command`가 외부 task cancel(HTTP request
        # abort 등)과 close()로 인한 pending future cancel을 구분하여, 후자만
        # ConnectionError로 정규화한다. atom 작업 이력 260513.01 code-review P1.
        self._closed: bool = False

        self.on_close = on_close
        self.on_session_change = on_session_change

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
    def session_count(self) -> int:
        return len(self._sessions)

    def to_info(self) -> dict:
        return {
            "nodeId": self.node_id,
            "host": self.host,
            "port": self.port,
            "capabilities": self.capabilities,
            "connectedAt": self.connected_at.isoformat(),
            "sessionCount": self.session_count,
            "status": "connected",
        }

    # --- 명령 전송 ---

    def _next_request_id(self) -> str:
        self._request_counter += 1
        return f"req-{self._request_counter}-{int(time.time() * 1000)}"

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
        future: asyncio.Future[dict] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future

        message = {"type": command, "requestId": request_id, **payload}
        try:
            await self._send(message)
        except WebSocketDisconnect as e:
            self._pending.pop(request_id, None)
            # 노드가 connection 끊긴 상태에서 send 시도 — 호출자가 503으로 분류 가능하도록
            # ConnectionError로 정규화 (RuntimeError에 흡수되지 않게).
            raise ConnectionError(
                f"Node disconnected before send: command={command} ({e})"
            ) from e

        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            raise TimeoutError(
                f"Command {command} timed out after {timeout}s (request_id={request_id})"
            )
        except asyncio.CancelledError:
            # close()가 _pending future를 cancel() 호출한 경우 (노드 disconnect during await).
            # `self._closed` flag가 set이면 close()로 인한 cancel이며 호출자(라우트)가
            # 503으로 분류할 수 있도록 ConnectionError로 정규화한다. 그렇지 않으면
            # 외부 task cancellation(HTTP request abort 등)이므로 CancelledError 그대로 전파.
            if self._closed:
                raise ConnectionError(
                    f"Node disconnected during command: {command} (request_id={request_id})"
                )
            raise
        finally:
            self._pending.pop(request_id, None)

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

    async def send_subscribe_events(
        self, session_id: str, callback: Callable
    ) -> str:
        subscribe_id = str(uuid.uuid4())

        if session_id not in self._subscribe_listeners:
            self._subscribe_listeners[session_id] = {}
        self._subscribe_listeners[session_id][subscribe_id] = callback

        await self._send({
            "type": CMD_SUBSCRIBE_EVENTS,
            "agentSessionId": session_id,
            "subscribeId": subscribe_id,
        })
        return subscribe_id

    def unsubscribe_events(self, session_id: str, subscribe_id: str) -> None:
        listeners = self._subscribe_listeners.get(session_id)
        if listeners:
            listeners.pop(subscribe_id, None)
            if not listeners:
                del self._subscribe_listeners[session_id]

    # --- 수신 메시지 처리 ---

    async def handle_message(self, data: dict) -> None:
        msg_type = data.get("type")
        request_id = data.get("requestId")

        # pending request에 대한 응답
        if request_id and request_id in self._pending:
            future = self._pending.pop(request_id)
            if not future.done():
                if msg_type == EVT_ERROR:
                    future.set_exception(
                        RuntimeError(data.get("message", "Unknown error"))
                    )
                else:
                    future.set_result(data)
            return

        # 이벤트 디스패치
        if msg_type == EVT_SESSION_CREATED:
            await self._on_session_created(data)
        elif msg_type == EVT_EVENT:
            await self._on_event(data)
        elif msg_type == EVT_SESSIONS_UPDATE:
            await self._on_sessions_update(data)
        elif msg_type == EVT_SESSION_UPDATED:
            await self._on_session_updated(data)
        elif msg_type == EVT_SESSION_DELETED:
            await self._on_session_deleted(data)
        elif msg_type == EVT_HEALTH_STATUS:
            await self._on_health_status(data)
        elif msg_type == EVT_INPUT_REQUEST:
            # 빌드 20: input_request는 PushNotifier가 알림 발사하는 hook 지점.
            # node_manager._on_session_change가 "node_session_input_request"로
            # 정규화하여 listener에 fan-out한다.
            if self.on_session_change:
                await self.on_session_change(self.node_id, "input_request", data)
        elif msg_type == EVT_ERROR:
            logger.warning(
                "Error from node %s: %s", self.node_id, data.get("message")
            )
        else:
            logger.debug(
                "Unknown message type from node %s: %s", self.node_id, msg_type
            )

    async def _on_session_created(self, data: dict) -> None:
        session_id = data.get("agentSessionId")
        if session_id:
            self._sessions[session_id] = {
                "agentSessionId": session_id,
                "status": data.get("status", "running"),
                "nodeId": self.node_id,
            }
            if self.on_session_change:
                await self.on_session_change(
                    self.node_id, "session_created", data
                )

    async def _on_event(self, data: dict) -> None:
        session_id = data.get("agentSessionId") or data.get("sessionId")
        subscribe_id = data.get("subscribeId")

        if session_id and session_id in self._subscribe_listeners:
            listeners = self._subscribe_listeners[session_id]
            if subscribe_id and subscribe_id in listeners:
                await listeners[subscribe_id](data)
            else:
                # broadcast to all listeners for this session
                for cb in list(listeners.values()):
                    await cb(data)

    async def _on_sessions_update(self, data: dict) -> None:
        sessions = data.get("sessions", [])
        self._sessions.clear()
        for s in sessions:
            sid = s.get("agentSessionId") or s.get("session_id")
            if sid:
                self._sessions[sid] = s
        if self.on_session_change:
            await self.on_session_change(
                self.node_id, "sessions_update", data
            )

    async def _on_session_updated(self, data: dict) -> None:
        session_id = data.get("agentSessionId") or data.get("session_id")
        if session_id and session_id in self._sessions:
            self._sessions[session_id].update(data)
        if self.on_session_change:
            await self.on_session_change(
                self.node_id, "session_updated", data
            )

    async def _on_session_deleted(self, data: dict) -> None:
        session_id = data.get("agentSessionId") or data.get("session_id")
        if session_id:
            self._sessions.pop(session_id, None)
        if self.on_session_change:
            await self.on_session_change(
                self.node_id, "session_deleted", data
            )

    async def _on_health_status(self, data: dict) -> None:
        logger.debug("Health status from node %s: %s", self.node_id, data)

    # --- 연결 종료 ---

    async def close(self) -> None:
        # _send_command가 close()로 인한 cancel을 외부 task cancel과 구분할 수 있도록
        # flag를 먼저 set한 뒤 future를 cancel.
        self._closed = True
        # cancel all pending futures
        for future in self._pending.values():
            if not future.done():
                future.cancel()
        self._pending.clear()
        self._subscribe_listeners.clear()

        try:
            await self._ws.close()
        except Exception:
            pass

        if self.on_close:
            cb = self.on_close
            self.on_close = None  # 이중 호출 방지 — ws_handler finally와 register_node 중복 호출
            await cb(self)
