"""cross_node_relay — soul-server 간 cross-node 인터벤션 릴레이.

caller 세션이 다른 노드에 있어 로컬 add_intervention이 실패한 경우,
upstream(orchestrator)을 통해 cross-node로 인터벤션을 전달한다.
"""

import logging
import re
from typing import Optional

import httpx

from soul_server.config import get_settings

logger = logging.getLogger(__name__)


async def relay_cross_node_intervention(
    caller_session_id: str,
    text: str,
    caller_info: Optional[dict] = None,
) -> None:
    """로컬 알림 실패 시 upstream을 통해 cross-node 인터벤션을 시도한다.

    settings.soulstream_upstream_url이 없으면 silent return (single-node 환경).
    settings.auth_bearer_token이 비어 있으면 headers={}로 호출 (개발 모드 호환).

    caller_info(통합 v1)를 명시하면 body에 forward한다 — F-11C fix(2026-05-09, atom F-11):
    위임 자식 완료 통지가 cross-node fallback 시 caller_info를 잃어 dashboard owner
    portrait로 fallback되던 결함을 닫는다. None이면 body에 키 없음 (기존 호환).
    """
    try:
        settings = get_settings()
        upstream_url = getattr(settings, "soulstream_upstream_url", None)
        if not upstream_url:
            return

        http_url = re.sub(r"^wss://", "https://", upstream_url)
        http_url = re.sub(r"^ws://", "http://", http_url)
        http_url = re.sub(r"/ws/.*$", "", http_url)

        auth_token = getattr(settings, "auth_bearer_token", "")
        headers = {"Authorization": f"Bearer {auth_token}"} if auth_token else {}

        body: dict = {"text": text, "user": "agent"}
        if caller_info:
            body["caller_info"] = caller_info

        async with httpx.AsyncClient(timeout=10.0, headers=headers) as client:
            resp = await client.post(
                f"{http_url}/api/sessions/{caller_session_id}/intervene",
                json=body,
            )
            resp.raise_for_status()
        logger.info(
            f"Cross-node notification sent to {caller_session_id} via upstream"
        )
    except Exception as remote_err:
        logger.error(
            f"Cross-node notification failed for {caller_session_id}: {remote_err}"
        )
