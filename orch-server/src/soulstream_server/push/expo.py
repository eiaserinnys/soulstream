"""Expo Push API 구현.

POST https://exp.host/--/api/v2/push/send → APNs / FCM 자동 위임.
응답이 항상 배열 형태로 옴에 주의 (단일 토큰 발송도 마찬가지).
"""

import logging
from typing import Any

import httpx

from .provider import PushNotificationProvider, SendResult

logger = logging.getLogger(__name__)


class ExpoPushProvider(PushNotificationProvider):
    """Expo Push 게이트웨이 호출. httpx 비동기 클라이언트 사용."""

    URL = "https://exp.host/--/api/v2/push/send"
    DEFAULT_TIMEOUT = 10.0

    def __init__(self, *, timeout: float = DEFAULT_TIMEOUT, http_client: httpx.AsyncClient | None = None):
        # 테스트용으로 외부에서 httpx.AsyncClient(MockTransport)를 주입할 수 있게 한다.
        # 미주입 시 호출마다 새 client를 만든다 (운영 호출 빈도가 낮아 OK).
        self._timeout = timeout
        self._injected_client = http_client

    async def send(self, token: str, title: str, body: str, data: dict) -> SendResult:
        payload = {
            "to": token,
            "title": title,
            "body": body,
            "data": data,
            "sound": "default",
            "priority": "high",
        }
        try:
            if self._injected_client is not None:
                r = await self._injected_client.post(self.URL, json=payload)
            else:
                async with httpx.AsyncClient(timeout=self._timeout) as client:
                    r = await client.post(self.URL, json=payload)
            return _parse_response(r.json())
        except Exception as e:
            logger.warning("[push.expo] send failed: %s", e)
            return SendResult(ok=False, invalid_token=False, error=str(e))


def _parse_response(payload: Any) -> SendResult:
    """Expo 응답 파싱.

    실측 응답 형식 (Expo Push API):
    - 단일 to (dict 본문 1건): {"data": {"status": "ok", "id": "..."}}
    - 배열 messages (배열 본문):  {"data": [{"status": "ok", ...}, ...]}
    - 에러:                      {"data": {"status": "error", "details": {"error": "DeviceNotRegistered"}}}
                                 또는 {"data": [{"status": "error", ...}]}

    빌드 20 초기 명세는 "항상 배열"로 단정했으나 실측 결과 단일 to 발송 시 dict가 옴.
    두 형태를 모두 안전하게 처리한다.
    """
    raw = (payload or {}).get("data")
    if isinstance(raw, list):
        if not raw:
            return SendResult(ok=False, invalid_token=False, error="empty data list")
        first = raw[0] or {}
    elif isinstance(raw, dict):
        first = raw
    else:
        return SendResult(ok=False, invalid_token=False, error="unexpected response shape")
    if first.get("status") == "error":
        details = first.get("details") or {}
        err = details.get("error") or first.get("message") or "unknown"
        return SendResult(
            ok=False,
            invalid_token=(err == "DeviceNotRegistered"),
            error=err,
        )
    return SendResult(ok=True, invalid_token=False)
