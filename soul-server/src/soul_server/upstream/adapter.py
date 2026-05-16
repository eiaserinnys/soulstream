"""UpstreamAdapter — 소울스트림 서버에 역방향 WebSocket 연결하는 어댑터.

기존 HTTP API와 동일한 TaskManager 메서드를 호출하며,
연결 방향만 반대(소울 서버 → 소울스트림)이다.
소울스트림에 연결하지 않아도 기존 독립 실행 모드에는 영향이 없다.

본 모듈은 lifecycle + connection을 담당하고, 명령 처리와 이벤트 relay는
``CommandDispatcher`` / ``EventRelay``에 composition으로 위임한다.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import TYPE_CHECKING

import aiohttp

from .protocol import EVT_ERROR, EVT_NODE_REGISTER, EVT_SESSIONS_UPDATE
from .reconnect import ReconnectPolicy
from .command_handler import CommandDispatcher
from .event_relay import EventRelay
from soul_server.service.session_query_service import get_session_query_service

if TYPE_CHECKING:
    from soul_server.service.agent_registry import AgentRegistry
    from soul_server.service.engine_adapter import SoulEngineAdapter
    from soul_server.service.postgres_session_db import PostgresSessionDB
    from soul_server.service.resource_manager import ResourceManager
    from soul_server.service.session_broadcaster import SessionBroadcaster
    from soul_server.service.task_manager import TaskManager

logger = logging.getLogger(__name__)

_MAX_PORTRAIT_SIZE = 512 * 1024  # 512KB — 초과 시 base64 인코딩 스킵


class UpstreamAdapter:
    """소울스트림 서버에 역방향 연결하는 어댑터.

    기존 HTTP API와 동일한 TaskManager 메서드를 호출하며,
    연결 방향만 반대(소울 서버 → 소울스트림).

    명령 처리는 ``self._dispatcher`` (CommandDispatcher),
    이벤트 relay는 ``self._relay`` (EventRelay)에 composition으로 위임.
    """

    def __init__(
        self,
        task_manager: "TaskManager",
        soul_engine: "SoulEngineAdapter",
        resource_manager: "ResourceManager",
        session_broadcaster: "SessionBroadcaster",
        upstream_url: str,
        node_id: str,
        session_db: "PostgresSessionDB",
        host: str = "",
        port: int = 0,
        agent_registry: "AgentRegistry | None" = None,
        user_name: str = "",
        user_portrait_path: str = "",
        auth_bearer_token: str = "",
    ) -> None:
        self._tm = task_manager
        self._engine = soul_engine
        self._rm = resource_manager
        self._broadcaster = session_broadcaster
        self._url = upstream_url
        self._node_id = node_id
        self._session_db = session_db
        self._host = host
        self._port = port
        self._agent_registry = agent_registry
        self._user_name = user_name
        self._user_portrait_path = user_portrait_path
        self._auth_bearer_token = auth_bearer_token
        # 재연결 루프에서 매 시도마다 같은 error 로그를 쏟지 않도록 플래그로 억제한다.
        # 연결 성공 시 리셋되어 이후 새 문제는 다시 error로 기록된다.
        self._auth_warned = False

        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._session: aiohttp.ClientSession | None = None
        self._reconnect = ReconnectPolicy()
        self._running = False
        self._stream_tasks: dict[str, asyncio.Task] = {}

        # ─── Composition: EventRelay와 CommandDispatcher ──────────
        # _stream_tasks는 두 컴포넌트가 reference로 공유한다 (mutation 양쪽 가능).
        self._relay = EventRelay(
            task_manager=self._tm,
            broadcaster=self._broadcaster,
            send_fn=self._send,
            stream_tasks=self._stream_tasks,
            is_running=lambda: self._running,
        )
        self._dispatcher = CommandDispatcher(
            task_manager=self._tm,
            soul_engine=self._engine,
            resource_manager=self._rm,
            node_id=self._node_id,
            send_fn=self._send,
            send_error_fn=self._send_error,
            stream_tasks=self._stream_tasks,
            event_relay=self._relay,
        )

    # ─── Lifecycle ──────────────────────────────────

    async def run(self) -> None:
        """연결 루프 시작. 연결이 끊기면 자동 재연결한다.

        외부에서 asyncio.create_task(adapter.run())으로 호출한다.
        """
        self._running = True
        self._session = aiohttp.ClientSession()

        try:
            while self._running:
                try:
                    await self._connect_and_serve()
                except (
                    aiohttp.WSServerHandshakeError,
                    aiohttp.ClientConnectorError,
                    aiohttp.ClientError,
                    ConnectionError,
                    OSError,
                ) as e:
                    if not self._running:
                        break
                    logger.warning("Upstream connection failed: %s", e)
                except Exception:
                    if not self._running:
                        break
                    logger.exception("Unexpected error in upstream connection")

                # 연결 종료 시 broadcast 리스너 정리
                await self._relay.stop_broadcast()

                if self._running:
                    await self._reconnect.wait()
        finally:
            await self._cleanup()

    async def shutdown(self) -> None:
        """연결 종료. lifespan shutdown에서 호출한다."""
        self._running = False

        # broadcast 태스크 정리
        await self._relay.stop_broadcast()

        # 스트리밍 태스크 취소
        for task in self._stream_tasks.values():
            task.cancel()
        self._stream_tasks.clear()

        if self._ws and not self._ws.closed:
            await self._ws.close()

        if self._session and not self._session.closed:
            await self._session.close()

    # ─── Connection ─────────────────────────────────

    @staticmethod
    def _encode_portrait(path: str, cache_key_prefix: str = "upstream") -> str | None:
        """portrait를 64x64 PNG로 리사이즈한 뒤 base64 인코딩. 실패 시 None.

        portrait_utils.get_cached_portrait를 통해 메모리 + 디스크 캐시를 활용한다.
        리사이즈된 PNG는 일반적으로 ~5KB이므로 _MAX_PORTRAIT_SIZE(512KB) 가드는
        defense-in-depth 차원으로 유지하되 거의 발동하지 않는다.

        Args:
            path: 원본 portrait 파일 경로.
            cache_key_prefix: 캐시 키 prefix (agent/user 등 종류 분리용).
                같은 path를 다른 용도로 사용해도 캐시 충돌 없이 분리.
        """
        if not path:
            return None
        # lazy import to avoid bootstrap cycle
        from soul_server.api.portrait_utils import get_cached_portrait

        cache_key = f"{cache_key_prefix}:{path}"
        data = get_cached_portrait(cache_key, path)
        if data is None:
            logger.warning("portrait 로드/리사이즈 실패: %s", path)
            return None
        if len(data) > _MAX_PORTRAIT_SIZE:
            # 리사이즈 후에도 초과하는 경우는 거의 없으나 defense-in-depth
            logger.warning(
                "리사이즈된 portrait도 초과: %s (%d bytes)", path, len(data)
            )
            return None
        return base64.b64encode(data).decode("ascii")

    def _build_registration_msg(self) -> dict:
        """노드 등록 메시지를 조립한다."""
        msg: dict = {
            "type": EVT_NODE_REGISTER,
            "node_id": self._node_id,
            "host": self._host,
            "port": self._port,
            "capabilities": {
                "max_concurrent": self._rm.max_concurrent,
            },
            # 옵션 D Phase A: 본 노드(soul-server)는 현재 Claude Code 백엔드만 실행.
            # orch SessionRouter가 agent.backend ↔ node.supported_backends 매칭 필터로 라우팅.
            "supported_backends": ["claude"],
        }

        # 에이전트 정보 — portrait는 base64로 인코딩하여 원격 HTTP 조회 불필요
        if self._agent_registry:
            agents = []
            for profile in self._agent_registry.list():
                agent_info: dict = {
                    "id": profile.id,
                    "name": profile.name,
                    "backend": profile.backend,
                    "portrait_url": (
                        f"/api/agents/{profile.id}/portrait"
                        if profile.portrait_path
                        else ""
                    ),
                }
                if profile.portrait_path:
                    b64 = self._encode_portrait(
                        profile.portrait_path,
                        cache_key_prefix=f"upstream:agent:{profile.id}",
                    )
                    if b64:
                        agent_info["portrait_b64"] = b64
                agents.append(agent_info)
            msg["agents"] = agents

        # 사용자 정보 — portrait 인코딩은 에이전트와 동일 패턴
        if self._user_name:
            user_info: dict = {
                "name": self._user_name,
                "hasPortrait": bool(self._user_portrait_path),
            }
            if self._user_portrait_path:
                b64 = self._encode_portrait(
                    self._user_portrait_path,
                    cache_key_prefix="upstream:user",
                )
                if b64:
                    user_info["portrait_b64"] = b64
            msg["user"] = user_info

        return msg

    async def _connect_and_serve(self) -> None:
        """WebSocket 연결 + 노드 등록 + 세션 동기화 + 명령 수신 루프."""
        logger.info("Connecting to upstream: %s", self._url)

        # 프로덕션 미설정 경고 — 최초 1회 error, 이후 debug (재연결 스팸 억제)
        if not self._auth_bearer_token:
            from soul_server.config import get_settings

            if get_settings().is_production:
                if not self._auth_warned:
                    logger.error(
                        "Upstream adapter: AUTH_BEARER_TOKEN empty in production — "
                        "orch-server will likely reject this connection"
                    )
                    self._auth_warned = True
                else:
                    logger.debug(
                        "Upstream adapter: AUTH_BEARER_TOKEN still empty (reconnect)"
                    )

        # aiohttp는 `headers` 파라미터를 사용한다 (websockets 라이브러리의 extra_headers가 아니다).
        headers: dict[str, str] = {}
        if self._auth_bearer_token:
            headers["Authorization"] = f"Bearer {self._auth_bearer_token}"

        # max_msg_size — aiohttp 클라이언트 기본값 4MB는 cross-node attachment
        # 업로드(base64 인코딩된 8MB → ~10.7MB)를 거부한다. soul_server.constants
        # WS_INCOMING_MAX_MSG_SIZE(16MB)로 명시 — MAX_ATTACHMENT_SIZE 변경 시 함께
        # 갱신해야 한다 (정본은 constants 모듈).
        from soul_server.constants import WS_INCOMING_MAX_MSG_SIZE
        self._ws = await self._session.ws_connect(
            self._url,
            headers=headers,
            max_msg_size=WS_INCOMING_MAX_MSG_SIZE,
        )
        self._reconnect.reset()
        # 연결 성공 — auth 경고 플래그 리셋하여 다음 새 문제는 다시 error로 기록되게 한다.
        self._auth_warned = False
        logger.info("Connected to upstream (node_id=%s)", self._node_id)

        await self._send(self._build_registration_msg())

        # 세션 동기화: 구독 먼저 → 초기 전송 (이벤트 유실 방지)
        await self._relay.start_broadcast()
        await self._send_initial_sessions()

        # 명령 수신 루프
        async for msg in self._ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                try:
                    cmd = json.loads(msg.data)
                    await self._dispatcher.dispatch(cmd)
                except json.JSONDecodeError:
                    logger.warning("Invalid JSON from upstream: %s", msg.data[:200])
                except Exception:
                    logger.exception("Error handling upstream command")
            elif msg.type == aiohttp.WSMsgType.ERROR:
                logger.warning("WebSocket error: %s", self._ws.exception())
                break
            elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSING, aiohttp.WSMsgType.CLOSED):
                break

        logger.info("Upstream connection closed")

    async def _send_initial_sessions(self) -> None:
        """현재 활성 세션 목록을 오케스트레이터에 전송.

        running 상태 세션만 전송한다. 완료된 세션은 오케스트레이터 DB에 있으므로
        불필요한 동기화가 WebSocket 메시지 크기 제한(1MB)을 초과하는 것을 방지한다.
        """
        sessions, total = await get_session_query_service().get_all_sessions(status="running")
        await self._send({
            "type": EVT_SESSIONS_UPDATE,
            "sessions": sessions,
            "total": total,
        })
        logger.info("Sent initial sessions to upstream (count=%d)", total)

    # ─── Helpers ────────────────────────────────────

    async def _send(self, data: dict) -> None:
        """WebSocket으로 JSON 메시지 전송."""
        if self._ws and not self._ws.closed:
            await self._ws.send_json(data)

    async def _send_error(
        self,
        message: str,
        request_id: str = "",
        command_type: str = "",
    ) -> None:
        """에러 응답 전송."""
        await self._send({
            "type": EVT_ERROR,
            "message": message,
            "requestId": request_id,
            "command_type": command_type,
        })

    async def _cleanup(self) -> None:
        """연결 정리."""
        await self._relay.stop_broadcast()

        for task in self._stream_tasks.values():
            task.cancel()
        self._stream_tasks.clear()

        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None
        # shutdown 후 stale ws 참조를 막기 위해 명시적으로 정리.
        self._ws = None
