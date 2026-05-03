"""ExpoPushProvider 단위 테스트.

실제 Expo Push API를 호출하지 않고 httpx.MockTransport로 응답을 주입한다.
빌드 19까지 클라이언트가 응답을 single object로 받아 AttributeError가 났던
회귀를 막기 위해 응답이 항상 배열인 점을 명시 검증한다.
"""

from __future__ import annotations

import httpx
import pytest

from soulstream_server.push.expo import ExpoPushProvider, _parse_response


@pytest.mark.asyncio
async def test_send_success_returns_ok():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"data": [{"status": "ok", "id": "abc-123"}]},
        )

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http_client:
        provider = ExpoPushProvider(http_client=http_client)
        result = await provider.send(
            "ExponentPushToken[xxx]", "title", "body", {"k": "v"}
        )

    assert result.ok is True
    assert result.invalid_token is False
    assert result.error is None


@pytest.mark.asyncio
async def test_send_device_not_registered_marks_invalid():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": [
                    {
                        "status": "error",
                        "details": {"error": "DeviceNotRegistered"},
                        "message": "...",
                    }
                ]
            },
        )

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http_client:
        provider = ExpoPushProvider(http_client=http_client)
        result = await provider.send("token", "t", "b", {})

    assert result.ok is False
    assert result.invalid_token is True
    assert result.error == "DeviceNotRegistered"


@pytest.mark.asyncio
async def test_send_other_error_not_invalid_token():
    """MessageRateExceeded 등 토큰 무효가 아닌 오류는 invalid_token=False."""
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": [
                    {
                        "status": "error",
                        "details": {"error": "MessageRateExceeded"},
                    }
                ]
            },
        )

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http_client:
        provider = ExpoPushProvider(http_client=http_client)
        result = await provider.send("token", "t", "b", {})

    assert result.ok is False
    assert result.invalid_token is False
    assert result.error == "MessageRateExceeded"


@pytest.mark.asyncio
async def test_send_network_failure_returns_error():
    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http_client:
        provider = ExpoPushProvider(http_client=http_client)
        result = await provider.send("token", "t", "b", {})

    assert result.ok is False
    assert result.invalid_token is False
    assert "boom" in (result.error or "")


def test_parse_response_handles_list_form():
    """응답은 항상 배열 — 빌드 19에서 single object로 받아 AttributeError 났던 회귀 방지."""
    res = _parse_response({"data": [{"status": "ok", "id": "x"}]})
    assert res.ok is True


def test_parse_response_handles_empty_data():
    res = _parse_response({"data": []})
    assert res.ok is False
    assert res.invalid_token is False


def test_parse_response_handles_missing_data():
    res = _parse_response({})
    assert res.ok is False
