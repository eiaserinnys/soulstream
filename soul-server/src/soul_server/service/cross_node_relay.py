"""
cross_node_relay — soul-server 간 cross-node 인터벤션 릴레이.

caller 세션이 다른 노드에 있어 로컬 add_intervention이 실패한 경우,
upstream(orchestrator)을 통해 cross-node로 인터벤션을 전달한다.

task_manager에서 추출됨. settings·httpx만 사용하는 함수형 책임이라
클래스 없이 자유 함수로 둔다.
"""

import logging
import re

logger = logging.getLogger(__name__)


async def relay_cross_node_intervention(
    caller_session_id: str, text: str
) -> None:
    """로컬 알림 실패 시 upstream을 통해 cross-node 인터벤션을 시도한다.

    settings.soulstream_upstream_url이 없으면 silent return (single-node 환경).
    settings.auth_bearer_token이 비어 있으면 headers={}로 호출 (개발 모드 호환).
    """
    try:
        # lazy import — 모듈 로드 시점에 settings·httpx 의존성을 끌어들이지 않기 위함.
        # 본 함수는 실패 가능 부가 기능이므로 import 실패도 try/except로 흡수.
        # NOTE: re는 lazy 대상이 아니다 (표준 라이브러리, patch 의존성 없음) — top-level import.
        from soul_server.config import get_settings
        import httpx

        settings = get_settings()
        upstream_url = getattr(settings, "soulstream_upstream_url", None)
        if not upstream_url:
            return

        http_url = re.sub(r"^wss://", "https://", upstream_url)
        http_url = re.sub(r"^ws://", "http://", http_url)
        http_url = re.sub(r"/ws/.*$", "", http_url)

        auth_token = getattr(settings, "auth_bearer_token", "")
        headers = {"Authorization": f"Bearer {auth_token}"} if auth_token else {}

        async with httpx.AsyncClient(timeout=10.0, headers=headers) as client:
            resp = await client.post(
                f"{http_url}/api/sessions/{caller_session_id}/intervene",
                json={"text": text, "user": "agent"},
            )
            resp.raise_for_status()
        logger.info(
            f"Cross-node notification sent to {caller_session_id} via upstream"
        )
    except Exception as remote_err:
        logger.error(
            f"Cross-node notification failed for {caller_session_id}: {remote_err}"
        )
