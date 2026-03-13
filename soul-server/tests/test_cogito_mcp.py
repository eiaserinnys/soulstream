"""Tests for cogito MCP tools and REST API."""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from pathlib import Path

from soul_server.cogito import mcp_tools


@pytest.fixture(autouse=True)
def reset_mcp_state():
    """Reset module-level state before each test."""
    mcp_tools._brief_composer = None
    mcp_tools._manifest_path = None
    yield
    mcp_tools._brief_composer = None
    mcp_tools._manifest_path = None


def _unwrap(tool_or_func):
    """FunctionTool에서 원본 함수를 꺼낸다.

    fastmcp 2.x의 @tool()은 FunctionTool을 반환하므로,
    테스트에서 직접 호출할 때는 .fn으로 원본 함수를 꺼내야 한다.
    """
    return getattr(tool_or_func, "fn", tool_or_func)


# ---------------------------------------------------------------------------
# init()
# ---------------------------------------------------------------------------

class TestInit:
    def test_init_sets_state(self):
        composer = MagicMock()
        mcp_tools.init(composer, "/path/to/manifest.yaml")
        assert mcp_tools._brief_composer is composer
        assert mcp_tools._manifest_path == "/path/to/manifest.yaml"

    def test_init_warns_on_double_call(self, caplog):
        composer1 = MagicMock()
        composer2 = MagicMock()
        mcp_tools.init(composer1, "/path/1")
        with caplog.at_level("WARNING"):
            mcp_tools.init(composer2, "/path/2")
        assert "called more than once" in caplog.text
        assert mcp_tools._brief_composer is composer2


# ---------------------------------------------------------------------------
# reflect_service
# ---------------------------------------------------------------------------

class TestReflectService:
    async def test_no_manifest_path(self):
        fn = _unwrap(mcp_tools.reflect_service)
        result = await fn("test-svc")
        assert "error" in result
        assert "not configured" in result["error"].lower() or "COGITO_MANIFEST_PATH" in result["error"]

    async def test_service_not_found(self, tmp_path):
        manifest_file = tmp_path / "manifest.yaml"
        manifest_file.write_text("services:\n  - name: foo\n    type: external\n    static: {}\n")
        mcp_tools._manifest_path = str(manifest_file)

        fn = _unwrap(mcp_tools.reflect_service)
        result = await fn("nonexistent")
        assert "error" in result
        assert "찾을 수 없습니다" in result["error"]
        assert "available" in result
        assert "foo" in result["available"]

    async def test_external_service_level0(self, tmp_path):
        manifest_file = tmp_path / "manifest.yaml"
        manifest_file.write_text(
            "services:\n"
            "  - name: mcp-slack\n"
            "    type: external\n"
            "    static:\n"
            "      identity:\n"
            "        name: mcp-slack\n"
            "        port: 3101\n"
        )
        mcp_tools._manifest_path = str(manifest_file)

        fn = _unwrap(mcp_tools.reflect_service)
        result = await fn("mcp-slack", level=0)
        assert "identity" in result
        assert result["identity"]["name"] == "mcp-slack"

    async def test_external_service_rejects_deep_level(self, tmp_path):
        manifest_file = tmp_path / "manifest.yaml"
        manifest_file.write_text(
            "services:\n  - name: ext\n    type: external\n    static: {}\n"
        )
        mcp_tools._manifest_path = str(manifest_file)

        fn = _unwrap(mcp_tools.reflect_service)
        result = await fn("ext", level=1)
        assert "error" in result
        assert "Level 0" in result["error"]

    @patch("soul_server.cogito.mcp_tools._http_get")
    async def test_internal_service_level0(self, mock_get, tmp_path):
        manifest_file = tmp_path / "manifest.yaml"
        manifest_file.write_text(
            "services:\n  - name: svc\n    endpoint: http://localhost:3104/reflect\n"
        )
        mcp_tools._manifest_path = str(manifest_file)
        mock_get.return_value = {"identity": {"name": "svc"}, "capabilities": []}

        fn = _unwrap(mcp_tools.reflect_service)
        result = await fn("svc", level=0)
        mock_get.assert_called_once_with("http://localhost:3104/reflect")
        assert result["identity"]["name"] == "svc"

    @patch("soul_server.cogito.mcp_tools._http_get")
    async def test_internal_service_level1_with_capability(self, mock_get, tmp_path):
        manifest_file = tmp_path / "manifest.yaml"
        manifest_file.write_text(
            "services:\n  - name: svc\n    endpoint: http://localhost:3104/reflect\n"
        )
        mcp_tools._manifest_path = str(manifest_file)
        mock_get.return_value = {"configs": []}

        fn = _unwrap(mcp_tools.reflect_service)
        result = await fn("svc", level=1, capability="image_gen")
        mock_get.assert_called_once_with("http://localhost:3104/reflect/config/image_gen")

    @patch("soul_server.cogito.mcp_tools._http_get")
    async def test_internal_service_level3(self, mock_get, tmp_path):
        manifest_file = tmp_path / "manifest.yaml"
        manifest_file.write_text(
            "services:\n  - name: svc\n    endpoint: http://localhost:3104/reflect\n"
        )
        mcp_tools._manifest_path = str(manifest_file)
        mock_get.return_value = {"status": "healthy", "pid": 1234}

        fn = _unwrap(mcp_tools.reflect_service)
        result = await fn("svc", level=3)
        mock_get.assert_called_once_with("http://localhost:3104/reflect/runtime")
        assert result["status"] == "healthy"

    @patch("soul_server.cogito.mcp_tools._http_get", side_effect=Exception("connection refused"))
    async def test_internal_service_http_error(self, mock_get, tmp_path):
        manifest_file = tmp_path / "manifest.yaml"
        manifest_file.write_text(
            "services:\n  - name: svc\n    endpoint: http://localhost:3104/reflect\n"
        )
        mcp_tools._manifest_path = str(manifest_file)

        fn = _unwrap(mcp_tools.reflect_service)
        result = await fn("svc", level=0)
        assert "error" in result
        assert "connection refused" in result["error"]


# ---------------------------------------------------------------------------
# reflect_brief
# ---------------------------------------------------------------------------

class TestReflectBrief:
    async def test_no_composer(self):
        fn = _unwrap(mcp_tools.reflect_brief)
        result = await fn()
        assert "error" in result

    async def test_success(self):
        composer = MagicMock()
        composer.compose = AsyncMock(return_value=[
            ("svc1", "internal", {"identity": {"name": "svc1"}}),
            ("svc2", "external", {"identity": {"name": "svc2"}}),
        ])
        mcp_tools._brief_composer = composer

        fn = _unwrap(mcp_tools.reflect_brief)
        result = await fn()
        assert "services" in result
        assert len(result["services"]) == 2
        assert result["services"][0]["name"] == "svc1"
        assert result["services"][1]["type"] == "external"


# ---------------------------------------------------------------------------
# reflect_refresh
# ---------------------------------------------------------------------------

class TestReflectRefresh:
    async def test_no_composer(self):
        fn = _unwrap(mcp_tools.reflect_refresh)
        result = await fn()
        assert "error" in result

    async def test_success(self):
        composer = MagicMock()
        composer.write_brief = AsyncMock(return_value=Path("/output/brief.md"))
        mcp_tools._brief_composer = composer

        fn = _unwrap(mcp_tools.reflect_refresh)
        result = await fn()
        assert result["refreshed"] is True
        assert "brief.md" in result["path"]


# ---------------------------------------------------------------------------
# REST API /cogito/refresh
# ---------------------------------------------------------------------------

class TestApiRefresh:
    async def test_no_composer_returns_503(self):
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc_info:
            await mcp_tools.api_refresh()
        assert exc_info.value.status_code == 503

    async def test_success(self):
        composer = MagicMock()
        composer.write_brief = AsyncMock(return_value=Path("/output/brief.md"))
        mcp_tools._brief_composer = composer

        result = await mcp_tools.api_refresh()
        assert result["refreshed"] is True

    async def test_exception_returns_500(self):
        from fastapi import HTTPException

        composer = MagicMock()
        composer.write_brief = AsyncMock(side_effect=RuntimeError("disk full"))
        mcp_tools._brief_composer = composer

        with pytest.raises(HTTPException) as exc_info:
            await mcp_tools.api_refresh()
        assert exc_info.value.status_code == 500


# ---------------------------------------------------------------------------
# reflector_setup
# ---------------------------------------------------------------------------

class TestReflectorSetup:
    def test_reflector_identity(self):
        from soul_server.cogito.reflector_setup import reflect
        from soul_server.config import get_settings

        level0 = reflect.get_level0()

        assert level0["identity"]["name"] == "soulstream-server"
        assert level0["identity"]["port"] == get_settings().port

    def test_reflector_capabilities(self):
        """데코레이터 적용된 모듈을 임포트하면 capabilities가 등록된다."""
        import soul_server.api.tasks  # noqa: F401
        import soul_server.api.credentials  # noqa: F401
        import soul_server.service.runner_pool  # noqa: F401
        import soul_server.api.llm  # noqa: F401
        import soul_server.cogito.mcp_tools  # noqa: F401
        from soul_server.cogito.reflector_setup import reflect

        level0 = reflect.get_level0()
        cap_names = [c["name"] for c in level0["capabilities"]]
        assert "session_management" in cap_names
        assert "cogito" in cap_names

    def test_reflector_configs(self):
        from soul_server.cogito.reflector_setup import reflect

        level1 = reflect.get_level1()

        config_keys = [c["key"] for c in level1["configs"]]
        assert "WORKSPACE_DIR" in config_keys
        assert "PORT" in config_keys
