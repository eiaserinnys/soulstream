"""세션 이벤트를 구독하여 등록된 디바이스에 푸시를 발송하는 listener.

NodeManager listener 시그니처는 `(event_type, node_id, data)` 순서이고,
세션 단위 이벤트는 `_on_session_change`를 거쳐 `"node_session_{change_type}"` 형태로
정규화되어 listener에 도달한다 (node_manager.py:_emit_change 참조).

처리 이벤트:
- "node_unregistered"            : 노드 끊김 → status cache 정리 (stale 방지)
- "node_session_session_updated" : status가 completed/error로 전환된 순간 푸시
- "node_session_input_request"   : 사용자 입력 요청 → 푸시 (Step 6 forwarding 결과)

발송 모델: 사용자 단위 fan-out — 노드 소유자 email로 등록된 모든 디바이스에 push.
세션 시작 출처(soul-app, 슬랙봇, 웹 대시보드 등)와 무관하게 같은 사용자의
모든 등록 기기에 알림이 도착한다 (사용자 결정: 빌드 20).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .provider import PushNotificationProvider
from .repository import PushRepository

logger = logging.getLogger(__name__)


class PushNotifier:
    def __init__(
        self,
        provider: PushNotificationProvider,
        repo: PushRepository,
        node_manager: Any,
    ):
        self._provider = provider
        self._repo = repo
        self._node_manager = node_manager
        # (node_id, session_id) → 직전 status. terminal 전환 시점만 push 발사.
        # 메모리에만 유지 (orch-server 재시작 시 리셋되어도 OK — 첫 push는 "완료 알림"이 정상).
        self._last_status: dict[tuple[str, str], str] = {}

    def start(self) -> None:
        """node_manager에 listener 등록."""
        self._node_manager.add_change_listener(self._on_change)

    async def _on_change(
        self, event_type: str, node_id: str, data: dict | None
    ) -> None:
        """NodeManager listener 콜백.

        event_type 형태:
        - "node_registered" / "node_unregistered" : 노드 라이프사이클 (data=None)
        - "node_session_{change_type}"            : 세션 단위 이벤트 (정규화됨)
        """
        if event_type == "node_unregistered":
            # 해당 node_id의 모든 status cache 항목 정리
            keys = [k for k in self._last_status if k[0] == node_id]
            for k in keys:
                self._last_status.pop(k, None)
            return

        data = data or {}

        if event_type == "node_session_session_updated":
            await self._handle_session_updated(node_id, data)
            return

        if event_type == "node_session_input_request":
            await self._handle_input_request(node_id, data)
            return

    async def _handle_session_updated(self, node_id: str, data: dict) -> None:
        session_id = data.get("agentSessionId") or data.get("session_id")
        new_status = (data.get("status") or "").lower()
        if not session_id or not new_status:
            return
        key = (node_id, session_id)
        prev = self._last_status.get(key)
        self._last_status[key] = new_status
        # running/idle → completed/error 전환만 발사. 같은 status 재호출은 무시.
        if new_status in ("completed", "error") and prev != new_status:
            title = "세션 완료" if new_status == "completed" else "세션 오류"
            body = data.get("display_name") or session_id[:8]
            await self._send_to_user(
                node_id,
                title=title,
                body=body,
                data={"sessionId": session_id, "status": new_status},
            )

    async def _handle_input_request(self, node_id: str, data: dict) -> None:
        session_id = data.get("agentSessionId") or data.get("session_id")
        if not session_id:
            return
        prompt = (data.get("prompt") or "").strip()
        body = prompt[:80] if prompt else "에이전트가 입력을 기다리고 있습니다"
        await self._send_to_user(
            node_id,
            title="입력 요청",
            body=body,
            data={"sessionId": session_id, "kind": "input_request"},
        )

    async def _send_to_user(
        self, node_id: str, *, title: str, body: str, data: dict
    ) -> None:
        """노드 소유자의 모든 디바이스로 fan-out push."""
        user_info = self._node_manager.get_user_info(node_id)
        email = (user_info or {}).get("email")
        if not email:
            # 사용자 정보 없는 노드(예: 익명 노드) — silent skip
            return
        try:
            tokens = await self._repo.list_tokens(email)
        except Exception:
            logger.exception("[push] list_tokens failed for %s", email)
            return
        if not tokens:
            return

        async def _one(device_id: str, expo_token: str) -> None:
            res = await self._provider.send(expo_token, title, body, data)
            if res.invalid_token:
                try:
                    await self._repo.delete_token(email, device_id)
                except Exception:
                    logger.exception(
                        "[push] cleanup failed for %s/%s", email, device_id
                    )
            elif not res.ok:
                logger.warning("[push] send failed: %s", res.error)

        await asyncio.gather(
            *(_one(d, t) for d, t in tokens), return_exceptions=True
        )
