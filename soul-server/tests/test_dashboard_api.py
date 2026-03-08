"""
test_dashboard_api - 대시보드 프로필 API 테스트

/api/dashboard/config, /api/dashboard/portrait/{role} 엔드포인트 검증.
"""

import pytest
from unittest.mock import patch, MagicMock
from pathlib import Path

from fastapi.testclient import TestClient
from soul_server.api.dashboard import router, _portrait_cache, _load_and_resize_portrait


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
    settings.dash_assistant_name = "TestAssistant"
    settings.dash_assistant_id = "test_assistant_id"
    settings.dash_assistant_portrait = ""
    return settings


class TestGetDashboardConfig:
    """GET /api/dashboard/config 테스트"""

    def test_returns_profile_config(self, mock_settings):
        """프로필 설정을 JSON으로 반환"""
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router, prefix="/api")

        with patch("soul_server.api.dashboard.get_settings", return_value=mock_settings):
            client = TestClient(app)
            resp = client.get("/api/dashboard/config")

        assert resp.status_code == 200
        data = resp.json()
        assert data["user"]["name"] == "TestUser"
        assert data["user"]["id"] == "test_user_id"
        assert data["user"]["hasPortrait"] is False
        assert data["assistant"]["name"] == "TestAssistant"
        assert data["assistant"]["id"] == "test_assistant_id"
        assert data["assistant"]["hasPortrait"] is False

    def test_has_portrait_true_when_path_set(self, mock_settings):
        """초상화 경로가 설정되어 있으면 hasPortrait=True"""
        from fastapi import FastAPI

        mock_settings.dash_user_portrait = "/some/path/user.png"
        mock_settings.dash_assistant_portrait = "/some/path/assistant.png"

        app = FastAPI()
        app.include_router(router, prefix="/api")

        with patch("soul_server.api.dashboard.get_settings", return_value=mock_settings):
            client = TestClient(app)
            resp = client.get("/api/dashboard/config")

        data = resp.json()
        assert data["user"]["hasPortrait"] is True
        assert data["assistant"]["hasPortrait"] is True


class TestGetPortrait:
    """GET /api/dashboard/portrait/{role} 테스트"""

    def test_invalid_role_returns_404(self, mock_settings):
        """유효하지 않은 role은 404 반환"""
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router, prefix="/api")

        with patch("soul_server.api.dashboard.get_settings", return_value=mock_settings):
            client = TestClient(app)
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
        # 최소 유효 PNG 바이트
        png_bytes = (
            b'\x89PNG\r\n\x1a\n'  # signature
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

            # Pillow가 없을 수 있으므로 ImportError도 허용
            resp = client.get("/api/dashboard/portrait/user")

        # 파일이 존재하면 200, 이미지 데이터 반환
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "image/png"
        assert resp.headers["cache-control"] == "public, max-age=3600"
        assert len(resp.content) > 0

    def test_nonexistent_file_returns_404(self, mock_settings):
        """존재하지 않는 파일 경로면 404 반환"""
        from fastapi import FastAPI

        mock_settings.dash_assistant_portrait = "/nonexistent/path/assistant.png"

        app = FastAPI()
        app.include_router(router, prefix="/api")

        with patch("soul_server.api.dashboard.get_settings", return_value=mock_settings):
            client = TestClient(app)
            resp = client.get("/api/dashboard/portrait/assistant")

        assert resp.status_code == 404


class TestLoadAndResizePortrait:
    """_load_and_resize_portrait 단위 테스트"""

    def test_empty_path_returns_none(self):
        """빈 경로는 None 반환"""
        assert _load_and_resize_portrait("") is None

    def test_nonexistent_path_returns_none(self):
        """존재하지 않는 경로는 None 반환"""
        assert _load_and_resize_portrait("/nonexistent/file.png") is None
