"""ExpoPushProvider 단위 테스트.

실제 Expo Push API를 호출하지 않고 httpx.MockTransport로 응답을 주입한다.
Expo Push API는 단일 to 발송 시 data를 dict로, 배열 messages 발송 시 list로 반환한다.
빌드 20 초기 코드는 list만 처리해 단일 to 케이스에서 unexpected response shape로
실패했음 — 두 형태 모두 처리하도록 회귀 케이스 포함.
"""

from __future__ import annotations

import httpx
import pytest

from soulstream_server.push.expo import ExpoPushProvider, _parse_response


@pytest.mark.asyncio
async def test_send_success_dict_response():
    """단일 to 발송 — Expo가 data를 dict로 반환 (실측, 운영의 정상 경로)."""
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"data": {"status": "ok", "id": "abc-123"}},
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
async def test_send_success_list_response():
    """배열 messages 발송 — data가 list로 반환 (호환 검증)."""
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"data": [{"status": "ok", "id": "abc-123"}]},
        )

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http_client:
        provider = ExpoPushProvider(http_client=http_client)
        result = await provider.send("token", "t", "b", {})

    assert result.ok is True


@pytest.mark.asyncio
async def test_send_device_not_registered_marks_invalid():
    """DeviceNotRegistered — dict 형태 (단일 to)."""
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": {
                    "status": "error",
                    "details": {"error": "DeviceNotRegistered"},
                    "message": "...",
                }
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


def test_parse_response_handles_dict_form():
    """단일 to 발송 시 data가 dict — 운영의 정상 경로."""
    res = _parse_response({"data": {"status": "ok", "id": "x"}})
    assert res.ok is True


def test_parse_response_handles_list_form():
    """배열 messages 발송 시 data가 list — 호환 경로."""
    res = _parse_response({"data": [{"status": "ok", "id": "x"}]})
    assert res.ok is True


def test_parse_response_handles_dict_error():
    res = _parse_response(
        {"data": {"status": "error", "details": {"error": "DeviceNotRegistered"}}}
    )
    assert res.ok is False
    assert res.invalid_token is True


def test_parse_response_handles_empty_list():
    res = _parse_response({"data": []})
    assert res.ok is False
    assert res.invalid_token is False


def test_parse_response_handles_missing_data():
    res = _parse_response({})
    assert res.ok is False
