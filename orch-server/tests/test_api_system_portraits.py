"""T-G5-H — orch-server /api/system/portraits/{source} 라우트 검증.

R-3 (atom G-5, 2026-05-11): 시스템·봇 source(`system` / `channel_observer` / `trello_watcher`)의
정체성 아이콘 정적 호스팅. agent portrait `/api/nodes/{n}/agents/{id}/portrait`와 §9 대칭으로
verify_auth 의존성 포함.

검증 항목:
- 화이트리스트 source → 200 PNG (Cache-Control 1시간)
- 화이트리스트 외 source → 404
- 인증 없음(Authorization 헤더 부재) → 401 (agent portrait §9 대칭)
- magic bytes로 PNG 검증 (\\x89PNG)
"""


class TestSystemPortraitsAllowedSources:
    """화이트리스트 source는 200 PNG로 응답."""

    async def test_system_returns_png(self, client):
        """source=system → 200 image/png + PNG magic bytes."""
        resp = await client.get("/api/system/portraits/system")
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "image/png"
        assert resp.content[:4] == b"\x89PNG"

    async def test_channel_observer_returns_png(self, client):
        """source=channel_observer → 200 image/png."""
        resp = await client.get("/api/system/portraits/channel_observer")
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "image/png"
        assert resp.content[:4] == b"\x89PNG"

    async def test_trello_watcher_returns_png(self, client):
        """source=trello_watcher → 200 image/png."""
        resp = await client.get("/api/system/portraits/trello_watcher")
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "image/png"
        assert resp.content[:4] == b"\x89PNG"

    async def test_response_has_cache_control(self, client):
        """1시간 캐시 헤더 (agent portrait와 §9 대칭)."""
        resp = await client.get("/api/system/portraits/system")
        assert resp.status_code == 200
        assert "public" in resp.headers.get("cache-control", "")
        assert "max-age=3600" in resp.headers.get("cache-control", "")


class TestSystemPortraitsWhitelist:
    """화이트리스트 외 source는 404."""

    async def test_unknown_source_404(self, client):
        """화이트리스트 외 source → 404."""
        resp = await client.get("/api/system/portraits/unknown_bot")
        assert resp.status_code == 404

    async def test_agent_source_not_allowed(self, client):
        """agent source는 별 라우트(/api/nodes/.../portrait)이므로 본 라우트는 404."""
        resp = await client.get("/api/system/portraits/agent")
        assert resp.status_code == 404

    async def test_slack_source_not_allowed(self, client):
        """slack source는 slack profile image_192를 사용하므로 본 라우트는 404."""
        resp = await client.get("/api/system/portraits/slack")
        assert resp.status_code == 404


class TestSystemPortraitsAuth:
    """인증 게이트 — agent portrait §9 대칭."""

    async def test_no_auth_401(self, client):
        """Authorization 헤더 부재 시 401 (agent portrait와 §9 대칭)."""
        client.headers.pop("Authorization", None)
        resp = await client.get("/api/system/portraits/system")
        assert resp.status_code == 401

    async def test_invalid_token_401(self, client):
        """잘못된 Bearer 토큰 → 401."""
        client.headers["Authorization"] = "Bearer invalid-token"
        resp = await client.get("/api/system/portraits/system")
        assert resp.status_code == 401
