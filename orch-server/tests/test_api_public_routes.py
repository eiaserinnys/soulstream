"""Tests for 공개 엔드포인트 (/api/config, /api/health) 회귀 검증.

로그인 전에 호출되는 부팅 메타 엔드포인트가 인증 헤더 없이도 접근 가능해야 한다.
`_mount_api_routers`의 일괄 Bearer 가드에 재차 포함되거나, 데코레이터에서
`Depends(verify_auth)`가 복원되면 이 테스트가 즉시 실패한다.

교차 검증: /api/status는 보호가 유지되어야 하며, 헤더 없으면 401을 반환한다.
"""


class TestPublicRoutes:
    """공개 엔드포인트 무인증 접근 회귀 테스트."""

    async def test_config_is_public(self, client):
        """/api/config는 Authorization 헤더 없이 200을 반환해야 한다."""
        client.headers.pop("Authorization", None)
        resp = await client.get("/api/config")
        assert resp.status_code == 200
        body = resp.json()
        assert "mode" in body
        assert "auth" in body
        assert "features" in body

    async def test_health_is_public(self, client):
        """/api/health는 Authorization 헤더 없이 200을 반환해야 한다."""
        client.headers.pop("Authorization", None)
        resp = await client.get("/api/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

    async def test_protected_endpoint_still_guarded(self, client):
        """교차 검증: /api/status는 가드 유지 — 헤더 없으면 401."""
        client.headers.pop("Authorization", None)
        resp = await client.get("/api/status")
        assert resp.status_code == 401
