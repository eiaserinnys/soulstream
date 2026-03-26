"""
test_dashboard_api - 대시보드 프로필 API 테스트

/api/dashboard/config, /api/dashboard/portrait/{role} 엔드포인트 검증.
"""

import pytest
from unittest.mock import patch, MagicMock
from pathlib import Path

from fastapi.testclient import TestClient
from soul_server.api.dashboard import router
from soul_server.api.portrait_utils import _portrait_cache, load_and_resize_portrait
from soul_server.service.agent_registry import AgentProfile, AgentRegistry


@pytest.fixture(autouse=True)
def clear_portrait_cache():
    """각 테스트 전에 초상화 캐시 초기화"""
    _portrait_cache.clear()
    yield
    _portrait_cache.clear()


@pytest.fixture
def mock_settings():
    """테스트용 Settings mock"""
    settings = MagicMock()
    settings.dash_user_name = "TestUser"
    settings.dash_user_id = "test_user_id"
    settings.dash_user_portrait = ""
    return settings


@pytest.fixture
def mock_registry_empty():
    """에이전트 없는 빈 레지스트리"""
    return AgentRegistry([])


@pytest.fixture
def mock_registry_with_agents():
    """에이전트가 있는 레지스트리"""
    return AgentRegistry([
        AgentProfile(id="agent1", name="Agent One", workspace_dir="/ws1", portrait_path="/img/one.png"),
        AgentProfile(id="agent2", name="Agent Two", workspace_dir="/ws2"),
    ])


class TestGetDashboardConfig:
    """GET /api/dashboard/config 테스트"""

    def test_returns_user_and_agents(self, mock_settings, mock_registry_with_agents):
        """user 프로필과 agents 목록을 JSON으로 반환"""
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router, prefix="/api")

        with (
            patch("soul_server.api.dashboard.get_settings", return_value=mock_settings),
            patch("soul_server.main.get_agent_registry", return_value=mock_registry_with_agents),
        ):
            client = TestClient(app)
            resp = client.get("/api/dashboard/config")

        assert resp.status_code == 200
        data = resp.json()
        assert data["user"]["name"] == "TestUser"
        assert data["user"]["id"] == "test_user_id"
        assert data["user"]["hasPortrait"] is False
        # assistant 섹션은 없어야 함
        assert "assistant" not in data
        # agents 배열
        assert len(data["agents"]) == 2
        assert data["agents"][0]["id"] == "agent1"
        assert data["agents"][0]["name"] == "Agent One"
        assert data["agents"][0]["hasPortrait"] is True
        assert data["agents"][0]["portraitUrl"] == "/api/agents/agent1/portrait"
        assert data["agents"][1]["id"] == "agent2"
        assert data["agents"][1]["hasPortrait"] is False
        assert data["agents"][1]["portraitUrl"] is None

    def test_empty_agents_when_no_registry(self, mock_settings, mock_registry_empty):
        """agents.yaml이 없으면 agents 빈 배열 반환"""
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router, prefix="/api")

        with (
            patch("soul_server.api.dashboard.get_settings", return_value=mock_settings),
            patch("soul_server.main.get_agent_registry", return_value=mock_registry_empty),
        ):
            client = TestClient(app)
            resp = client.get("/api/dashboard/config")

        data = resp.json()
        assert data["agents"] == []


class TestGetPortrait:
    """GET /api/dashboard/portrait/{role} 테스트"""

    def test_invalid_role_returns_404(self, mock_settings):
        """user 외의 role은 404 반환"""
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router, prefix="/api")

        with patch("soul_server.api.dashboard.get_settings", return_value=mock_settings):
            client = TestClient(app)
            # assistant는 이제 404
            resp = client.get("/api/dashboard/portrait/assistant")
            assert resp.status_code == 404

            resp = client.get("/api/dashboard/portrait/unknown")
            assert resp.status_code == 404

    def test_no_portrait_path_returns_404(self, mock_settings):
        """초상화 경로가 빈 문자열이면 404 반환"""
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router, prefix="/api")

        with patch("soul_server.api.dashboard.get_settings", return_value=mock_settings):
            client = TestClient(app)
            resp = client.get("/api/dashboard/portrait/user")

        assert resp.status_code == 404

    def test_portrait_served_with_cache(self, mock_settings, tmp_path):
        """초상화 이미지가 있으면 PNG로 서빙하고 캐시"""
        from fastapi import FastAPI

        # 테스트용 이미지 파일 생성 (1x1 PNG)
        img_path = tmp_path / "user.png"
        png_bytes = (
            b'\x89PNG\r\n\x1a\n'
            b'\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01'
            b'\x08\x02\x00\x00\x00\x90wS\xde'
            b'\x00\x00\x00\x0cIDATx'
            b'\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N'
            b'\x00\x00\x00\x00IEND\xaeB`\x82'
        )
        img_path.write_bytes(png_bytes)

        mock_settings.dash_user_portrait = str(img_path)

        app = FastAPI()
        app.include_router(router, prefix="/api")

        with patch("soul_server.api.dashboard.get_settings", return_value=mock_settings):
            client = TestClient(app)
            resp = client.get("/api/dashboard/portrait/user")

        assert resp.status_code == 200
        assert resp.headers["content-type"] == "image/png"
        assert resp.headers["cache-control"] == "public, max-age=3600"
        assert len(resp.content) > 0


class TestLoadAndResizePortrait:
    """load_and_resize_portrait 단위 테스트"""

    def test_empty_path_returns_none(self):
        """빈 경로는 None 반환"""
        assert load_and_resize_portrait("") is None

    def test_nonexistent_path_returns_none(self):
        """존재하지 않는 경로는 None 반환"""
        assert load_and_resize_portrait("/nonexistent/file.png") is None
