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

# 푸시 알림 body 길이 — iOS는 약 178자에서 잘리므로 100자 안팎이 안전.
# 잘릴 때 멀티바이트 깨짐 방지를 위해 단어 경계 우선 절단.
_PUSH_BODY_MAX = 100


def _push_body_preview(
    data: dict, session_id: str, *, fallback_title: str = ""
) -> str:
    """푸시 body 본문을 결정한다.

    우선순위:
    1. last_assistant_text (text_delta 누적, 어시스턴트 응답 정본 — task_models.py 주석:
       'TextDeltaSSEEvent.text는 block.text 전체, 청크 아님' 이라 마지막 delta가 응답 전체)
    2. last_message.preview (emit_session_message_updated 경로)
    3. display_name (session_info에 있을 경우)
    4. last_progress_text — '도구 실행 중...' 같은 진행 안내. 어시스턴트 본문은 아니지만
       빈 본문보다는 낫다.
    5. fallback_title 또는 session_id 일부 — title이 '세션 완료' 등 충분한 신호.

    값을 _PUSH_BODY_MAX로 truncate한다.
    """
    text = data.get("last_assistant_text")
    if not text:
        last_message = data.get("last_message") or {}
        if isinstance(last_message, dict):
            text = last_message.get("preview")
    if not text:
        text = data.get("display_name")
    if not text:
        text = data.get("last_progress_text")
    if not text:
        # session_id 일부는 사용자에게 의미 없으므로 마지막 fallback에서만 사용.
        text = fallback_title or session_id[:8]
    text = str(text).strip()
    if len(text) > _PUSH_BODY_MAX:
        truncated = text[:_PUSH_BODY_MAX].rstrip()
        # 마지막 공백에서 자르면 단어 깨짐 완화.
        last_space = truncated.rfind(" ")
        if last_space > _PUSH_BODY_MAX * 0.6:
            truncated = truncated[:last_space]
        text = truncated + "…"
    return text


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
        # 화이트리스트 게이트: LLM 세션과 비-사용자 시작 세션 차단.
        # 메타 소스: session_broadcaster가 wire에 싣는 session_type / caller_source.
        # session_type == "llm" 또는 caller_source ∉ {slack, browser, soul-app} 이면 silent skip.
        if data.get("session_type") == "llm":
            return
        src = (data.get("caller_source") or "").lower()
        if src not in ("slack", "browser", "soul-app"):
            return
        # wire format: soul-server `emit_session_updated` / `emit_session_phase`는
        # snake_case `agent_session_id`를 사용한다 (session_broadcaster.py:72,94).
        # 옛 wire(camelCase agentSessionId)도 호환성 유지를 위해 fallback에 둔다.
        session_id = (
            data.get("agent_session_id")
            or data.get("agentSessionId")
            or data.get("session_id")
        )
        new_status = (data.get("status") or "").lower()
        if not session_id or not new_status:
            logger.info(
                "[push] session_updated skipped — missing key (sid=%s status=%r data_keys=%s)",
                session_id, new_status, sorted((data or {}).keys()),
            )
            return
        key = (node_id, session_id)
        prev = self._last_status.get(key)
        self._last_status[key] = new_status
        # running/idle → completed/error 전환만 발사. 같은 status 재호출은 무시.
        will_fire = new_status in ("completed", "error") and prev != new_status
        logger.info(
            "[push] session_updated sid=%s prev=%s new=%s fire=%s",
            session_id[:8], prev, new_status, will_fire,
        )
        if will_fire:
            title = "세션 완료" if new_status == "completed" else "세션 오류"
            # 본문 우선순위: last_assistant_text → last_message.preview → display_name
            #              → last_progress_text → title fallback. (_push_body_preview 참조)
            body = _push_body_preview(data, session_id, fallback_title=title)
            logger.info(
                "[push] session_updated fire title=%r body=%r src=%s",
                title, body[:60], _body_source(data),
            )
            await self._send_to_user(
                node_id,
                title=title,
                body=body,
                data={
                    "sessionId": session_id,
                    "status": new_status,
                    "sessionType": data.get("session_type"),
                    "callerSource": data.get("caller_source"),
                },
            )

    async def _handle_input_request(self, node_id: str, data: dict) -> None:
        # 화이트리스트 게이트 (대칭): _handle_session_updated와 동일.
        if data.get("session_type") == "llm":
            return
        src = (data.get("caller_source") or "").lower()
        if src not in ("slack", "browser", "soul-app"):
            return
        # wire format은 _handle_session_updated와 동일하게 snake_case 정본 + camel/legacy fallback.
        session_id = (
            data.get("agent_session_id")
            or data.get("agentSessionId")
            or data.get("session_id")
        )
        if not session_id:
            logger.info("[push] input_request skipped — no session_id (data_keys=%s)", sorted((data or {}).keys()))
            return
        prompt = (data.get("prompt") or "").strip()
        if prompt:
            body = prompt if len(prompt) <= _PUSH_BODY_MAX else prompt[:_PUSH_BODY_MAX].rstrip() + "…"
        else:
            body = "에이전트가 입력을 기다리고 있습니다"
        logger.info(
            "[push] input_request fire sid=%s body=%r",
            session_id[:8], body[:60],
        )
        await self._send_to_user(
            node_id,
            title="입력 요청",
            body=body,
            data={
                "sessionId": session_id,
                "kind": "input_request",
                "sessionType": data.get("session_type"),
                "callerSource": data.get("caller_source"),
            },
        )

    async def _send_to_user(
        self, node_id: str, *, title: str, body: str, data: dict
    ) -> None:
        """노드 소유자의 모든 디바이스로 fan-out push."""
        user_info = self._node_manager.get_user_info(node_id)
        email = (user_info or {}).get("email")
        if not email:
            # 사용자 정보 없는 노드(예: 익명 노드) — silent skip
            logger.info("[push] send skipped — no email for node=%s", node_id)
            return
        try:
            tokens = await self._repo.list_tokens(email)
        except Exception:
            logger.exception("[push] list_tokens failed for %s", email)
            return
        if not tokens:
            logger.info("[push] send skipped — no tokens for %s", email)
            return
        logger.info(
            "[push] send → email=%s devices=%d title=%r",
            email, len(tokens), title,
        )

        async def _one(device_id: str, expo_token: str) -> None:
            res = await self._provider.send(expo_token, title, body, data)
            if res.invalid_token:
                logger.info(
                    "[push] invalid_token cleanup email=%s device=%s", email, device_id,
                )
                try:
                    await self._repo.delete_token(email, device_id)
                except Exception:
                    logger.exception(
                        "[push] cleanup failed for %s/%s", email, device_id
                    )
            elif not res.ok:
                logger.warning("[push] send failed: %s", res.error)
            else:
                logger.info(
                    "[push] sent ok email=%s device=%s", email, device_id,
                )

        await asyncio.gather(
            *(_one(d, t) for d, t in tokens), return_exceptions=True
        )


def _body_source(data: dict) -> str:
    """body가 어떤 키에서 왔는지 디버그용 라벨."""
    if data.get("last_assistant_text"):
        return "last_assistant_text"
    last_message = data.get("last_message") or {}
    if isinstance(last_message, dict) and last_message.get("preview"):
        return "last_message.preview"
    if data.get("display_name"):
        return "display_name"
    if data.get("last_progress_text"):
        return "last_progress_text"
    return "fallback_title_or_session_id"
