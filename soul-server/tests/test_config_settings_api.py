"""
Config Settings API 테스트

GET /api/config/settings — 설정 조회
PUT /api/config/settings — 설정 업데이트 (.env 쓰기 + 핫리로드)
SETTINGS_REGISTRY 완전성 검증
"""

import os
import tempfile
from dataclasses import fields as dataclass_fields
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from soul_server.config import (
    Settings,
    SettingMeta,
    SETTINGS_REGISTRY,
    CATEGORY_LABELS,
    get_settings,
)


# === REGISTRY 완전성 테스트 ===

def test_registry_covers_all_settings_fields():
    """Settings dataclass의 모든 필드가 SETTINGS_REGISTRY에 등록되어야 한다."""
    settings_fields = {f.name for f in dataclass_fields(Settings)}
    registry_fields = set(SETTINGS_REGISTRY.keys())
    missing = settings_fields - registry_fields
    extra = registry_fields - settings_fields
    assert not missing, f"REGISTRY에 미등록된 Settings 필드: {missing}"
    assert not extra, f"Settings에 없는 REGISTRY 항목: {extra}"


def test_registry_categories_all_have_labels():
    """REGISTRY에 사용된 모든 카테고리가 CATEGORY_LABELS에 정의되어야 한다."""
    used_categories = {meta.category for meta in SETTINGS_REGISTRY.values()}
    missing = used_categories - set(CATEGORY_LABELS.keys())
    assert not missing, f"CATEGORY_LABELS에 미등록된 카테고리: {missing}"


def test_registry_env_keys_unique():
    """env_key는 모두 고유해야 한다."""
    env_keys = [meta.env_key for meta in SETTINGS_REGISTRY.values()]
    duplicates = [k for k in env_keys if env_keys.count(k) > 1]
    assert not duplicates, f"중복 env_key: {set(duplicates)}"


# === API 테스트 ===

@pytest.fixture
def app():
    """테스트용 FastAPI 앱"""
    from fastapi import FastAPI
    from soul_server.dashboard.api_router import router

    app = FastAPI()
    app.include_router(router)
    return app


@pytest.fixture
def client(app):
    return TestClient(app)


@pytest.fixture(autouse=True)
def mock_auth():
    """Dashboard 인증 우회"""
    from soul_server.dashboard.auth import require_dashboard_auth

    async def noop():
        pass

    with patch("soul_server.dashboard.api_router.require_dashboard_auth", noop):
        yield


@pytest.fixture(autouse=True)
def reset_settings_cache():
    """각 테스트 전후로 Settings 캐시 초기화"""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


class TestGetConfigSettings:
    """GET /api/config/settings"""

    def test_returns_categories(self, client):
        response = client.get("/api/config/settings")
        assert response.status_code == 200
        data = response.json()
        assert "categories" in data
        assert "serendipityAvailable" in data
        assert isinstance(data["categories"], list)

    def test_categories_have_expected_structure(self, client):
        response = client.get("/api/config/settings")
        data = response.json()
        for cat in data["categories"]:
            assert "name" in cat
            assert "label" in cat
            assert "fields" in cat
            for field in cat["fields"]:
                assert "key" in field
                assert "field_name" in field
                assert "label" in field
                assert "value_type" in field
                assert "sensitive" in field
                assert "hot_reloadable" in field
                assert "read_only" in field

    def test_sensitive_fields_masked(self, client):
        response = client.get("/api/config/settings")
        data = response.json()
        for cat in data["categories"]:
            for field in cat["fields"]:
                if field["sensitive"] and field["field_name"] in SETTINGS_REGISTRY:
                    meta = SETTINGS_REGISTRY[field["field_name"]]
                    actual_value = getattr(get_settings(), field["field_name"], "")
                    if actual_value and str(actual_value).strip():
                        assert field["value"] == "********", (
                            f"Sensitive field {field['key']} not masked"
                        )

    def test_all_category_labels_present(self, client):
        response = client.get("/api/config/settings")
        data = response.json()
        cat_names = [c["name"] for c in data["categories"]]
        # 모든 REGISTRY 카테고리가 응답에 있어야 함
        expected_cats = {meta.category for meta in SETTINGS_REGISTRY.values()}
        for expected in expected_cats:
            assert expected in cat_names, f"카테고리 '{expected}'가 응답에 없음"


class TestPutConfigSettings:
    """PUT /api/config/settings"""

    @pytest.fixture
    def temp_env_file(self, tmp_path):
        """임시 .env 파일 생성 + CWD 패치"""
        env_file = tmp_path / ".env"
        env_file.write_text(
            "LOG_LEVEL=INFO\n"
            "WORKSPACE_DIR=/tmp/test\n"
            "MAX_CONCURRENT_SESSIONS=3\n"
        )
        with patch("pathlib.Path.cwd", return_value=tmp_path):
            yield env_file

    def test_read_only_field_rejected(self, client):
        response = client.put(
            "/api/config/settings",
            json={"changes": {"WORKSPACE_DIR": "/new/path"}},
        )
        assert response.status_code == 400

    def test_unknown_field_error(self, client, temp_env_file):
        response = client.put(
            "/api/config/settings",
            json={"changes": {"NONEXISTENT_VAR": "value"}},
        )
        assert response.status_code == 400
        data = response.json()
        # HTTPException wraps errors in detail
        errors = data.get("errors") or data.get("detail", {}).get("errors", [])
        assert any("Unknown" in e for e in errors)

    def test_successful_update(self, client, temp_env_file):
        response = client.put(
            "/api/config/settings",
            json={"changes": {"LOG_LEVEL": "DEBUG"}},
        )
        assert response.status_code == 200
        data = response.json()
        assert "LOG_LEVEL" in data["applied"]

        # .env에 실제로 기록되었는지 확인
        content = temp_env_file.read_text()
        assert "DEBUG" in content

    def test_hot_reloadable_vs_restart_required(self, client, temp_env_file):
        response = client.put(
            "/api/config/settings",
            json={"changes": {
                "LOG_LEVEL": "DEBUG",
                "MAX_CONCURRENT_SESSIONS": "10",
            }},
        )
        assert response.status_code == 200
        data = response.json()
        assert "LOG_LEVEL" in data["applied"]
        assert "MAX_CONCURRENT_SESSIONS" in data["restart_required"]
