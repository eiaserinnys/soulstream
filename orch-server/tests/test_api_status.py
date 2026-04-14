"""Tests for /api/status endpoint on soulstream-server."""

import pytest
from httpx import ASGITransport, AsyncClient


@pytest.mark.asyncio
async def test_api_status_returns_not_draining():
    """soulstream-server는 graceful_shutdown이 없으므로 /api/status는 항상 is_draining: false를 반환한다."""
    from soulstream_server.main import create_app

    app = create_app()
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get("/api/status")

    assert resp.status_code == 200
    data = resp.json()
    assert data["is_draining"] is False
    assert data["healthy"] is True


@pytest.mark.asyncio
async def test_api_status_is_stable_across_requests():
    """연속 호출해도 항상 동일한 is_draining: false를 반환한다."""
    from soulstream_server.main import create_app

    app = create_app()
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        for _ in range(3):
            resp = await client.get("/api/status")
            assert resp.status_code == 200
            assert resp.json()["is_draining"] is False
