"""Tests for cogito MCP tools and REST API."""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from pathlib import Path

from soul_server.cogito import mcp_tools, mcp_cogito, mcp_multi_node
from soul_server.service.postgres_session_db import PostgresSessionDB


@pytest.fixture(autouse=True)
def reset_mcp_state():
    """Reset module-level state before each test."""
    mcp_tools._brief_composer = None
    mcp_tools._manifest_path = None
    mcp_tools._orch_base = None
    mcp_cogito._brief_composer = None
    mcp_cogito._manifest_path = None
    mcp_multi_node._orch_base = None
    mcp_multi_node._orch_headers = {}
    yield
    mcp_tools._brief_composer = None
    mcp_tools._manifest_path = None
    mcp_tools._orch_base = None
    mcp_cogito._brief_composer = None
    mcp_cogito._manifest_path = None
    mcp_multi_node._orch_base = None
    mcp_multi_node._orch_headers = {}


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
        mcp_cogito._manifest_path = str(manifest_file)

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
        mcp_cogito._manifest_path = str(manifest_file)

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
        mcp_cogito._manifest_path = str(manifest_file)

        fn = _unwrap(mcp_tools.reflect_service)
        result = await fn("ext", level=1)
        assert "error" in result
        assert "Level 0" in result["error"]

    @patch("soul_server.cogito.mcp_cogito._http_get")
    async def test_internal_service_level0(self, mock_get, tmp_path):
        manifest_file = tmp_path / "manifest.yaml"
        manifest_file.write_text(
            "services:\n  - name: svc\n    endpoint: http://localhost:3104/reflect\n"
        )
        mcp_tools._manifest_path = str(manifest_file)
        mcp_cogito._manifest_path = str(manifest_file)
        mock_get.return_value = {"identity": {"name": "svc"}, "capabilities": []}

        fn = _unwrap(mcp_tools.reflect_service)
        result = await fn("svc", level=0)
        mock_get.assert_called_once_with("http://localhost:3104/reflect")
        assert result["identity"]["name"] == "svc"

    @patch("soul_server.cogito.mcp_cogito._http_get")
    async def test_internal_service_level1_with_capability(self, mock_get, tmp_path):
        manifest_file = tmp_path / "manifest.yaml"
        manifest_file.write_text(
            "services:\n  - name: svc\n    endpoint: http://localhost:3104/reflect\n"
        )
        mcp_tools._manifest_path = str(manifest_file)
        mcp_cogito._manifest_path = str(manifest_file)
        mock_get.return_value = {"configs": []}

        fn = _unwrap(mcp_tools.reflect_service)
        result = await fn("svc", level=1, capability="image_gen")
        mock_get.assert_called_once_with("http://localhost:3104/reflect/config/image_gen")

    @patch("soul_server.cogito.mcp_cogito._http_get")
    async def test_internal_service_level3(self, mock_get, tmp_path):
        manifest_file = tmp_path / "manifest.yaml"
        manifest_file.write_text(
            "services:\n  - name: svc\n    endpoint: http://localhost:3104/reflect\n"
        )
        mcp_tools._manifest_path = str(manifest_file)
        mcp_cogito._manifest_path = str(manifest_file)
        mock_get.return_value = {"status": "healthy", "pid": 1234}

        fn = _unwrap(mcp_tools.reflect_service)
        result = await fn("svc", level=3)
        mock_get.assert_called_once_with("http://localhost:3104/reflect/runtime")
        assert result["status"] == "healthy"

    @patch("soul_server.cogito.mcp_cogito._http_get", side_effect=Exception("connection refused"))
    async def test_internal_service_http_error(self, mock_get, tmp_path):
        manifest_file = tmp_path / "manifest.yaml"
        manifest_file.write_text(
            "services:\n  - name: svc\n    endpoint: http://localhost:3104/reflect\n"
        )
        mcp_tools._manifest_path = str(manifest_file)
        mcp_cogito._manifest_path = str(manifest_file)

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
        mcp_cogito._brief_composer = composer

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
        mcp_cogito._brief_composer = composer

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
        mcp_cogito._brief_composer = composer

        result = await mcp_tools.api_refresh()
        assert result["refreshed"] is True

    async def test_exception_returns_500(self):
        from fastapi import HTTPException

        composer = MagicMock()
        composer.write_brief = AsyncMock(side_effect=RuntimeError("disk full"))
        mcp_tools._brief_composer = composer
        mcp_cogito._brief_composer = composer

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

        assert level0["identity"]["name"] == "soulstream-soul-server"
        assert level0["identity"]["port"] == get_settings().port

    def test_reflector_capabilities(self):
        """데코레이터 적용된 모듈을 임포트하면 capabilities가 등록된다."""
        import soul_server.api.tasks  # noqa: F401
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


# ---------------------------------------------------------------------------
# get_session_name / set_session_name
# ---------------------------------------------------------------------------


def _make_mock_session_db(sessions=None):
    """PostgresSessionDB의 AsyncMock을 생성한다."""
    db = AsyncMock(spec=PostgresSessionDB)
    _sessions = dict(sessions) if sessions else {}

    async def _get_session(sid):
        return _sessions.get(sid)

    async def _rename_session(sid, name):
        if sid in _sessions:
            _sessions[sid]["display_name"] = name if name and name.strip() else None

    async def _get_catalog():
        return {
            "folders": [],
            "sessions": {
                sid: {"folderId": None, "displayName": s.get("display_name")}
                for sid, s in _sessions.items()
            },
        }

    db.get_session = AsyncMock(side_effect=_get_session)
    db.rename_session = AsyncMock(side_effect=_rename_session)
    db.get_catalog = AsyncMock(side_effect=_get_catalog)
    return db


@pytest.fixture
def session_db():
    """Create a mock PostgresSessionDB with a test session."""
    sessions = {
        "test-sess-001": {
            "session_id": "test-sess-001",
            "status": "running",
            "prompt": "hello",
            "session_type": "claude",
            "display_name": None,
        }
    }
    return _make_mock_session_db(sessions)


class TestGetSessionName:
    async def test_no_db_returns_error(self):
        fn = _unwrap(mcp_tools.get_session_name)
        with patch("soul_server.cogito.mcp_session_mgmt.get_session_db", side_effect=RuntimeError("no db")):
            result = await fn("test-sess-001")
        assert "error" in result

    async def test_session_not_found(self, session_db):
        fn = _unwrap(mcp_tools.get_session_name)
        with patch("soul_server.cogito.mcp_session_mgmt.get_session_db", return_value=session_db):
            result = await fn("nonexistent")
        assert "error" in result
        assert "찾을 수 없습니다" in result["error"]

    async def test_returns_none_when_no_name_set(self, session_db):
        fn = _unwrap(mcp_tools.get_session_name)
        with patch("soul_server.cogito.mcp_session_mgmt.get_session_db", return_value=session_db):
            result = await fn("test-sess-001")
        assert result["session_id"] == "test-sess-001"
        assert result["display_name"] is None

    async def test_returns_display_name(self, session_db):
        await session_db.rename_session("test-sess-001", "작업 세션")
        fn = _unwrap(mcp_tools.get_session_name)
        with patch("soul_server.cogito.mcp_session_mgmt.get_session_db", return_value=session_db):
            result = await fn("test-sess-001")
        assert result["display_name"] == "작업 세션"


class TestSetSessionName:
    async def test_no_db_returns_error(self):
        fn = _unwrap(mcp_tools.set_session_name)
        with patch("soul_server.cogito.mcp_session_mgmt.get_session_db", side_effect=RuntimeError("no db")):
            result = await fn("test-sess-001", "name")
        assert "error" in result

    async def test_session_not_found(self, session_db):
        fn = _unwrap(mcp_tools.set_session_name)
        with patch("soul_server.cogito.mcp_session_mgmt.get_session_db", return_value=session_db):
            with patch("soul_server.cogito.mcp_session_mgmt.get_catalog_service", side_effect=RuntimeError("not init")):
                result = await fn("nonexistent", "name")
        assert "error" in result

    async def test_sets_name(self, session_db):
        fn = _unwrap(mcp_tools.set_session_name)
        with patch("soul_server.cogito.mcp_session_mgmt.get_session_db", return_value=session_db):
            with patch("soul_server.cogito.mcp_session_mgmt.get_catalog_service", side_effect=RuntimeError("not init")):
                result = await fn("test-sess-001", "세션 이름 테스트")
        assert result["session_id"] == "test-sess-001"
        assert result["display_name"] == "세션 이름 테스트"
        # DB에도 반영 확인
        session = await session_db.get_session("test-sess-001")
        assert session["display_name"] == "세션 이름 테스트"

    async def test_empty_string_removes_name(self, session_db):
        await session_db.rename_session("test-sess-001", "기존 이름")
        fn = _unwrap(mcp_tools.set_session_name)
        with patch("soul_server.cogito.mcp_session_mgmt.get_session_db", return_value=session_db):
            with patch("soul_server.cogito.mcp_session_mgmt.get_catalog_service", side_effect=RuntimeError("not init")):
                result = await fn("test-sess-001", "")
        assert result["display_name"] is None
        session = await session_db.get_session("test-sess-001")
        assert session["display_name"] is None

    async def test_whitespace_only_removes_name(self, session_db):
        await session_db.rename_session("test-sess-001", "기존 이름")
        fn = _unwrap(mcp_tools.set_session_name)
        with patch("soul_server.cogito.mcp_session_mgmt.get_session_db", return_value=session_db):
            with patch("soul_server.cogito.mcp_session_mgmt.get_catalog_service", side_effect=RuntimeError("not init")):
                result = await fn("test-sess-001", "   ")
        assert result["display_name"] is None

    async def test_broadcasts_catalog_update(self, session_db):
        mock_catalog_svc = AsyncMock()
        mock_catalog_svc.rename_session = AsyncMock()
        fn = _unwrap(mcp_tools.set_session_name)
        with patch("soul_server.cogito.mcp_session_mgmt.get_session_db", return_value=session_db):
            with patch("soul_server.cogito.mcp_session_mgmt.get_catalog_service", return_value=mock_catalog_svc):
                await fn("test-sess-001", "브로드캐스트 테스트")
        mock_catalog_svc.rename_session.assert_awaited_once_with("test-sess-001", "브로드캐스트 테스트")


# ---------------------------------------------------------------------------
# list_sessions (improved with search + summary)
# ---------------------------------------------------------------------------


def _make_mock_task_manager(summary_result=None):
    """TaskManager의 AsyncMock을 생성한다."""
    tm = AsyncMock()
    if summary_result is None:
        summary_result = ([], 0)
    tm.list_sessions_summary = AsyncMock(return_value=summary_result)
    return tm


class TestListSessions:
    async def test_no_task_manager_returns_error(self):
        fn = _unwrap(mcp_tools.list_sessions)
        with patch("soul_server.cogito.mcp_session_query.get_session_query_service", side_effect=RuntimeError("no tm")):
            result = await fn()
        assert "error" in result

    async def test_returns_total_and_sessions(self):
        sessions = [
            {"session_id": "s1", "display_name": "세션1", "status": "idle",
             "session_type": "claude", "created_at": "2026-01-01", "updated_at": "2026-01-02",
             "event_count": 42, "caller_session_id": "sess-parent-abc"},
        ]
        tm = _make_mock_task_manager((sessions, 1))
        fn = _unwrap(mcp_tools.list_sessions)
        with patch("soul_server.cogito.mcp_session_query.get_session_query_service", return_value=tm):
            result = await fn(cursor=0, limit=20)
        assert result["total"] == 1
        assert len(result["sessions"]) == 1
        assert result["sessions"][0]["session_id"] == "s1"
        assert result["sessions"][0]["caller_session_id"] == "sess-parent-abc"
        assert result["next_cursor"] is None

    async def test_next_cursor_when_has_more(self):
        sessions = [{"session_id": f"s{i}"} for i in range(5)]
        tm = _make_mock_task_manager((sessions, 10))
        fn = _unwrap(mcp_tools.list_sessions)
        with patch("soul_server.cogito.mcp_session_query.get_session_query_service", return_value=tm):
            result = await fn(cursor=0, limit=5)
        assert result["next_cursor"] == 5

    async def test_search_parameter_forwarded(self):
        tm = _make_mock_task_manager(([], 0))
        fn = _unwrap(mcp_tools.list_sessions)
        with patch("soul_server.cogito.mcp_session_query.get_session_query_service", return_value=tm):
            await fn(search="테스트")
        tm.list_sessions_summary.assert_called_once_with(
            search="테스트", limit=20, offset=0, folder_id=None, node_id=None,
        )

    async def test_folder_id_filter_forwarded(self):
        tm = _make_mock_task_manager(([], 0))
        fn = _unwrap(mcp_tools.list_sessions)
        with patch("soul_server.cogito.mcp_session_query.get_session_query_service", return_value=tm):
            await fn(folder_id="claude")
        tm.list_sessions_summary.assert_called_once_with(
            search=None, limit=20, offset=0, folder_id="claude", node_id=None,
        )

    async def test_folder_name_resolves_to_folder_id(self):
        tm = _make_mock_task_manager(([], 0))
        tm.get_all_folders = AsyncMock(return_value=[
            {"id": "claude", "name": "⚙️ 클로드 코드 세션"},
            {"id": "other", "name": "🪞 서소영"},
        ])
        fn = _unwrap(mcp_tools.list_sessions)
        with patch("soul_server.cogito.mcp_session_query.get_session_query_service", return_value=tm):
            await fn(folder_name="⚙️ 클로드 코드 세션")
        tm.list_sessions_summary.assert_called_once_with(
            search=None, limit=20, offset=0, folder_id="claude", node_id=None,
        )

    async def test_folder_name_unknown_passes_none(self):
        tm = _make_mock_task_manager(([], 0))
        tm.get_all_folders = AsyncMock(return_value=[
            {"id": "claude", "name": "⚙️ 클로드 코드 세션"},
        ])
        fn = _unwrap(mcp_tools.list_sessions)
        with patch("soul_server.cogito.mcp_session_query.get_session_query_service", return_value=tm):
            await fn(folder_name="존재하지않는폴더")
        tm.list_sessions_summary.assert_called_once_with(
            search=None, limit=20, offset=0, folder_id=None, node_id=None,
        )

    async def test_node_id_filter_forwarded(self):
        tm = _make_mock_task_manager(([], 0))
        fn = _unwrap(mcp_tools.list_sessions)
        with patch("soul_server.cogito.mcp_session_query.get_session_query_service", return_value=tm):
            await fn(node_id="haniel-01")
        tm.list_sessions_summary.assert_called_once_with(
            search=None, limit=20, offset=0, folder_id=None, node_id="haniel-01",
        )

    async def test_node_name_treated_as_node_id(self):
        tm = _make_mock_task_manager(([], 0))
        fn = _unwrap(mcp_tools.list_sessions)
        with patch("soul_server.cogito.mcp_session_query.get_session_query_service", return_value=tm):
            await fn(node_name="haniel-01")
        tm.list_sessions_summary.assert_called_once_with(
            search=None, limit=20, offset=0, folder_id=None, node_id="haniel-01",
        )

    async def test_folder_id_takes_precedence_over_folder_name(self):
        """folder_id와 folder_name 동시 제공 시 folder_id 우선."""
        tm = _make_mock_task_manager(([], 0))
        fn = _unwrap(mcp_tools.list_sessions)
        with patch("soul_server.cogito.mcp_session_query.get_session_query_service", return_value=tm):
            await fn(folder_id="explicit-id", folder_name="⚙️ 클로드 코드 세션")
        # folder_name이 있어도 get_all_folders를 호출하지 않아야 함
        tm.get_all_folders.assert_not_called()
        tm.list_sessions_summary.assert_called_once_with(
            search=None, limit=20, offset=0, folder_id="explicit-id", node_id=None,
        )

    async def test_limit_capped_at_100(self):
        tm = _make_mock_task_manager(([], 0))
        fn = _unwrap(mcp_tools.list_sessions)
        with patch("soul_server.cogito.mcp_session_query.get_session_query_service", return_value=tm):
            await fn(limit=200)
        call_kwargs = tm.list_sessions_summary.call_args
        assert call_kwargs[1]["limit"] == 100 or call_kwargs[0][1] == 100


# ---------------------------------------------------------------------------
# list_session_events (improved with event_types + tool_content)
# ---------------------------------------------------------------------------


def _make_event_entry(event_id: int, event_type: str, payload_dict: dict) -> dict:
    """테스트용 이벤트 dict를 생성한다."""
    import json
    return {
        "id": event_id,
        "session_id": "test-sess",
        "event_type": event_type,
        "payload": json.dumps(payload_dict),
        "searchable_text": "",
        "created_at": "2026-01-01T00:00:00+00:00",
    }


class TestListSessionEvents:
    async def test_event_types_filter_forwarded(self, session_db):
        fn = _unwrap(mcp_tools.list_session_events)
        session_db.read_events = AsyncMock(return_value=[])
        session_db.count_events = AsyncMock(return_value=0)
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=session_db):
            await fn("test-sess-001", event_types=["user_message", "result"])
        call_args = session_db.read_events.call_args
        assert call_args[1]["event_types"] == ["user_message", "result"]

    async def test_tool_content_omit(self, session_db):
        events = [
            _make_event_entry(1, "tool_use", {"type": "tool_use", "input": "long input data", "tool": "Bash"}),
        ]
        fn = _unwrap(mcp_tools.list_session_events)
        session_db.read_events = AsyncMock(return_value=events)
        session_db.count_events = AsyncMock(return_value=1)
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=session_db):
            result = await fn("test-sess-001", tool_content="omit")
        ev = result["events"][0]["event"]
        assert "input" not in ev
        assert ev["type"] == "tool_use"

    async def test_tool_content_full(self, session_db):
        events = [
            _make_event_entry(1, "tool_use", {"type": "tool_use", "input": "x" * 1000, "tool": "Bash"}),
        ]
        fn = _unwrap(mcp_tools.list_session_events)
        session_db.read_events = AsyncMock(return_value=events)
        session_db.count_events = AsyncMock(return_value=1)
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=session_db):
            result = await fn("test-sess-001", tool_content="full")
        ev = result["events"][0]["event"]
        assert len(ev["input"]) == 1000  # 잘리지 않음

    async def test_tool_content_truncate_default(self, session_db):
        events = [
            _make_event_entry(1, "tool_use", {"type": "tool_use", "input": "x" * 1000, "tool": "Bash"}),
        ]
        fn = _unwrap(mcp_tools.list_session_events)
        session_db.read_events = AsyncMock(return_value=events)
        session_db.count_events = AsyncMock(return_value=1)
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=session_db):
            result = await fn("test-sess-001")  # 기본값: truncate, 500
        ev = result["events"][0]["event"]
        assert len(ev["input"]) < 1000  # 잘려야 함

    async def test_returns_total(self, session_db):
        fn = _unwrap(mcp_tools.list_session_events)
        session_db.read_events = AsyncMock(return_value=[])
        session_db.count_events = AsyncMock(return_value=42)
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=session_db):
            result = await fn("test-sess-001")
        assert result["total"] == 42

    async def test_db_level_limit(self, session_db):
        """DB에 limit+1로 요청하여 has_more를 판단한다."""
        fn = _unwrap(mcp_tools.list_session_events)
        session_db.read_events = AsyncMock(return_value=[])
        session_db.count_events = AsyncMock(return_value=0)
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=session_db):
            await fn("test-sess-001", limit=10)
        call_args = session_db.read_events.call_args
        assert call_args[1]["limit"] == 11  # limit + 1


# ---------------------------------------------------------------------------
# get_session_summary
# ---------------------------------------------------------------------------


class TestGetSessionSummary:
    async def test_session_not_found(self, session_db):
        fn = _unwrap(mcp_tools.get_session_summary)
        session_db.count_events = AsyncMock(return_value=0)
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=session_db):
            result = await fn("nonexistent")
        assert "error" in result

    async def test_empty_session(self, session_db):
        fn = _unwrap(mcp_tools.get_session_summary)
        session_db.count_events = AsyncMock(return_value=0)
        session_db.read_events = AsyncMock(return_value=[])
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=session_db):
            result = await fn("test-sess-001")
        assert result["session_id"] == "test-sess-001"
        assert result["total_events"] == 0
        assert result["turns"] == []

    async def test_single_turn(self, session_db):
        # 페이로드 정정: type "result" → "complete". CompleteEvent.result 본문 키는 그대로
        # 유지 (PREVIEW_FIELD_MAP["complete"] = "result").
        events = [
            _make_event_entry(1, "user_message", {"type": "user_message", "text": "안녕하세요"}),
            _make_event_entry(5, "tool_start", {"type": "tool_start", "tool": "Bash"}),
            _make_event_entry(6, "tool_start", {"type": "tool_start", "tool": "Bash"}),
            _make_event_entry(7, "tool_start", {"type": "tool_start", "tool": "Read"}),
            _make_event_entry(10, "context_usage", {"type": "context_usage", "percent": 16.7, "used_tokens": 33359, "max_tokens": 200000}),
            _make_event_entry(15, "complete", {"type": "complete", "result": "작업을 완료했습니다."}),
        ]
        fn = _unwrap(mcp_tools.get_session_summary)
        session_db.count_events = AsyncMock(return_value=100)
        session_db.read_events = AsyncMock(return_value=events)
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=session_db):
            result = await fn("test-sess-001")

        assert result["total_events"] == 100
        assert len(result["turns"]) == 1

        turn = result["turns"][0]
        assert turn["user_message"] == "안녕하세요"
        assert turn["response_preview"] == "작업을 완료했습니다."
        assert turn["context_usage"]["percent"] == 16.7
        assert turn["tools_used"] == {"Bash": 2, "Read": 1}

    async def test_multiple_turns(self, session_db):
        events = [
            _make_event_entry(1, "user_message", {"type": "user_message", "text": "첫 번째 질문"}),
            _make_event_entry(5, "complete", {"type": "complete", "result": "첫 번째 답변"}),
            _make_event_entry(10, "user_message", {"type": "user_message", "text": "두 번째 질문"}),
            _make_event_entry(15, "complete", {"type": "complete", "result": "두 번째 답변"}),
        ]
        fn = _unwrap(mcp_tools.get_session_summary)
        session_db.count_events = AsyncMock(return_value=200)
        session_db.read_events = AsyncMock(return_value=events)
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=session_db):
            result = await fn("test-sess-001")
        assert len(result["turns"]) == 2
        assert result["turns"][0]["user_message"] == "첫 번째 질문"
        assert result["turns"][0]["response_preview"] == "첫 번째 답변"
        assert result["turns"][1]["user_message"] == "두 번째 질문"
        assert result["turns"][1]["response_preview"] == "두 번째 답변"

    async def test_response_truncated(self, session_db):
        long_response = "x" * 1000
        events = [
            _make_event_entry(1, "user_message", {"type": "user_message", "text": "질문"}),
            _make_event_entry(5, "complete", {"type": "complete", "result": long_response}),
        ]
        fn = _unwrap(mcp_tools.get_session_summary)
        session_db.count_events = AsyncMock(return_value=10)
        session_db.read_events = AsyncMock(return_value=events)
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=session_db):
            result = await fn("test-sess-001", max_response_chars=100)
        preview = result["turns"][0]["response_preview"]
        assert len(preview) == 103  # 100 + "..."
        assert preview.endswith("...")

    async def test_event_types_filter_used(self, session_db):
        """read_events에 event_types 필터가 전달되는지 확인한다.

        v3 fix 후 turn-final 3종(result, complete, error)이 모두 포함되어야 한다.
        """
        fn = _unwrap(mcp_tools.get_session_summary)
        session_db.count_events = AsyncMock(return_value=0)
        session_db.read_events = AsyncMock(return_value=[])
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=session_db):
            await fn("test-sess-001")
        call_args = session_db.read_events.call_args
        assert set(call_args[1]["event_types"]) == {
            "user_message", "context_usage", "tool_start",
            "result", "complete", "error",
        }

    # ------------------------------------------------------------------
    # T1~T10 회귀 케이스 — v3 fix ratchet
    # ------------------------------------------------------------------

    async def test_t1_short_complete(self, session_db):
        """T1: 짧은 complete 본문은 전문 그대로 preview."""
        body = "짧은 응답"
        events = [
            _make_event_entry(1, "user_message", {"type": "user_message", "text": "q"}),
            _make_event_entry(2, "complete", {"type": "complete", "result": body}),
        ]
        fn = _unwrap(mcp_tools.get_session_summary)
        session_db.count_events = AsyncMock(return_value=2)
        session_db.read_events = AsyncMock(return_value=events)
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=session_db):
            result = await fn("test-sess-001", max_response_chars=500)
        assert result["turns"][0]["response_preview"] == body

    async def test_t2_medium_truncate(self, session_db):
        """T2: 중간 길이 + max=100 → 100자 + '...'."""
        body = "x" * 1000
        events = [
            _make_event_entry(1, "user_message", {"type": "user_message", "text": "q"}),
            _make_event_entry(2, "complete", {"type": "complete", "result": body}),
        ]
        fn = _unwrap(mcp_tools.get_session_summary)
        session_db.count_events = AsyncMock(return_value=2)
        session_db.read_events = AsyncMock(return_value=events)
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=session_db):
            result = await fn("test-sess-001", max_response_chars=100)
        preview = result["turns"][0]["response_preview"]
        assert len(preview) == 103
        assert preview.endswith("...")
        assert preview[:100] == "x" * 100

    async def test_t3_long_truncate(self, session_db):
        """T3: 긴 본문(10K자) + max=200."""
        body = "y" * 10_000
        events = [
            _make_event_entry(1, "user_message", {"type": "user_message", "text": "q"}),
            _make_event_entry(2, "complete", {"type": "complete", "result": body}),
        ]
        fn = _unwrap(mcp_tools.get_session_summary)
        session_db.count_events = AsyncMock(return_value=2)
        session_db.read_events = AsyncMock(return_value=events)
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=session_db):
            result = await fn("test-sess-001", max_response_chars=200)
        preview = result["turns"][0]["response_preview"]
        assert len(preview) == 203
        assert preview.endswith("...")

    async def test_t4_very_long_truncate(self, session_db):
        """T4: 매우 긴 본문(20K자) + max=8000 — 위임 명세의 핵심 케이스."""
        body = "z" * 20_000
        events = [
            _make_event_entry(1, "user_message", {"type": "user_message", "text": "q"}),
            _make_event_entry(2, "complete", {"type": "complete", "result": body}),
        ]
        fn = _unwrap(mcp_tools.get_session_summary)
        session_db.count_events = AsyncMock(return_value=2)
        session_db.read_events = AsyncMock(return_value=events)
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=session_db):
            result = await fn("test-sess-001", max_response_chars=8000)
        preview = result["turns"][0]["response_preview"]
        assert len(preview) == 8003
        assert preview.endswith("...")

    async def test_t5_tool_only_turn_preview_none(self, session_db):
        """T5: turn-final 이벤트가 없으면 response_preview는 None을 유지."""
        events = [
            _make_event_entry(1, "user_message", {"type": "user_message", "text": "q"}),
            _make_event_entry(2, "tool_start", {"type": "tool_start", "tool": "Bash"}),
        ]
        fn = _unwrap(mcp_tools.get_session_summary)
        session_db.count_events = AsyncMock(return_value=2)
        session_db.read_events = AsyncMock(return_value=events)
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=session_db):
            result = await fn("test-sess-001")
        assert len(result["turns"]) == 1
        assert result["turns"][0]["response_preview"] is None
        assert result["turns"][0]["tools_used"] == {"Bash": 1}

    async def test_t6_multi_turn_assertions(self, session_db):
        """T6: 멀티턴 — 각 turn이 자기 complete 본문을 가짐."""
        events = [
            _make_event_entry(1, "user_message", {"type": "user_message", "text": "Q1"}),
            _make_event_entry(2, "complete", {"type": "complete", "result": "A1"}),
            _make_event_entry(3, "user_message", {"type": "user_message", "text": "Q2"}),
            _make_event_entry(4, "complete", {"type": "complete", "result": "A2"}),
        ]
        fn = _unwrap(mcp_tools.get_session_summary)
        session_db.count_events = AsyncMock(return_value=4)
        session_db.read_events = AsyncMock(return_value=events)
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=session_db):
            result = await fn("test-sess-001")
        assert [t["response_preview"] for t in result["turns"]] == ["A1", "A2"]

    async def test_t7_list_content_payload(self, session_db):
        """T7: complete.result가 list of {type:text, text:...} 형식이면 join 후 사용."""
        events = [
            _make_event_entry(1, "user_message", {"type": "user_message", "text": "q"}),
            _make_event_entry(2, "complete", {"type": "complete", "result": [
                {"type": "text", "text": "first"},
                {"type": "text", "text": "second"},
            ]}),
        ]
        fn = _unwrap(mcp_tools.get_session_summary)
        session_db.count_events = AsyncMock(return_value=2)
        session_db.read_events = AsyncMock(return_value=events)
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=session_db):
            result = await fn("test-sess-001")
        assert result["turns"][0]["response_preview"] == "first second"

    async def test_t8_error_turn_preview(self, session_db):
        """T8: 에러 turn — result(부분 출력) + error(런타임 오류) 순서.

        나중에 도착한 error 이벤트가 preview를 덮어쓴다.
        ErrorEvent.message 필드를 PREVIEW_FIELD_MAP['error']='message'로 lookup.
        """
        events = [
            _make_event_entry(1, "user_message", {"type": "user_message", "text": "q"}),
            _make_event_entry(2, "result", {"type": "result", "output": "부분 출력", "success": False}),
            _make_event_entry(3, "error", {"type": "error", "message": "런타임 오류"}),
        ]
        fn = _unwrap(mcp_tools.get_session_summary)
        session_db.count_events = AsyncMock(return_value=3)
        session_db.read_events = AsyncMock(return_value=events)
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=session_db):
            result = await fn("test-sess-001")
        assert result["turns"][0]["response_preview"] == "런타임 오류"

    async def test_t9_success_result_then_complete(self, session_db):
        """T9: 성공 turn — result(먼저) + complete(나중) 모두 같은 본문."""
        body = "최종 답변"
        events = [
            _make_event_entry(1, "user_message", {"type": "user_message", "text": "q"}),
            _make_event_entry(2, "result", {"type": "result", "output": body, "success": True}),
            _make_event_entry(3, "complete", {"type": "complete", "result": body}),
        ]
        fn = _unwrap(mcp_tools.get_session_summary)
        session_db.count_events = AsyncMock(return_value=3)
        session_db.read_events = AsyncMock(return_value=events)
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=session_db):
            result = await fn("test-sess-001")
        assert result["turns"][0]["response_preview"] == body

    def test_t10_preview_field_map_keys_canonical(self):
        """T10: PREVIEW_FIELD_MAP 키 정합 단언 — 정본 정정 ratchet (F-4).

        실제 SSE 이벤트 스키마와 매핑이 정합함을 보장한다:
        - ResultSSEEvent.output (`packages/soul-common/.../schemas.py: ResultSSEEvent`)
        - CompleteEvent.result
        - ErrorEvent.message
        """
        from soul_server.service.task_models import PREVIEW_FIELD_MAP

        assert PREVIEW_FIELD_MAP["result"] == "output"
        assert PREVIEW_FIELD_MAP["complete"] == "result"
        assert PREVIEW_FIELD_MAP["error"] == "message"
        assert PREVIEW_FIELD_MAP["thinking"] == "thinking"
        assert PREVIEW_FIELD_MAP["text_delta"] == "text"
        assert PREVIEW_FIELD_MAP["away_summary"] == "content"


# ---------------------------------------------------------------------------
# _omit_tool_content / _truncate_tool_event helpers
# ---------------------------------------------------------------------------


class TestOmitToolContent:
    def test_removes_all_content_fields(self):
        ev = {"type": "tool_use", "input": "data", "output": "out", "content": "c", "result": "r", "tool": "Bash"}
        result = mcp_tools._omit_tool_content(ev)
        assert "input" not in result
        assert "output" not in result
        assert "content" not in result
        assert "result" not in result
        assert result["type"] == "tool_use"
        assert result["tool"] == "Bash"

    def test_does_not_modify_original(self):
        ev = {"type": "tool_use", "input": "data"}
        mcp_tools._omit_tool_content(ev)
        assert "input" in ev  # 원본 불변


# ---------------------------------------------------------------------------
# search_session_history (score from DB)
# ---------------------------------------------------------------------------


class TestSearchSessionHistoryScore:
    async def test_score_from_db(self):
        """search_session_history가 DB에서 반환된 score를 사용하는지 확인한다."""
        mock_db = AsyncMock(spec=PostgresSessionDB)
        mock_db.search_events = AsyncMock(return_value=[
            {
                "id": 1, "session_id": "s1", "event_type": "text_delta",
                "searchable_text": "hello world",
                "score": 0.75,
            }
        ])

        fn = _unwrap(mcp_tools.search_session_history)
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=mock_db):
            result = await fn(query="hello")

        assert len(result["results"]) == 1
        assert result["results"][0]["score"] == 0.75

    async def test_filters_forwarded(self):
        """event_types와 session_id 검색 옵션이 검색 엔진으로 전달된다."""
        mock_db = AsyncMock(spec=PostgresSessionDB)
        mock_db.search_events = AsyncMock(return_value=[
            {
                "id": 1, "session_id": "s1", "event_type": "user_message",
                "searchable_text": "hello world",
                "score": 0.8,
            }
        ])
        mock_db.search_events_by_session_id = AsyncMock(return_value=[
            {
                "id": 2, "session_id": "sess-hello", "event_type": "user_message",
                "searchable_text": "session match",
                "score": 0.5,
            }
        ])

        fn = _unwrap(mcp_tools.search_session_history)
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=mock_db):
            result = await fn(
                query="hello",
                session_ids=["s1"],
                event_types=["user_message"],
                search_session_id=True,
                top_k=10,
            )

        assert [r["event_id"] for r in result["results"]] == [1, 2]
        mock_db.search_events.assert_called_once_with(
            "hello", session_ids=["s1"], limit=10, event_types=["user_message"],
        )
        mock_db.search_events_by_session_id.assert_called_once_with(
            "hello", event_types=["user_message"], limit=10,
        )


# ---------------------------------------------------------------------------
# send_message_to_session
# ---------------------------------------------------------------------------

class TestSendMessageToSession:
    """send_message_to_session()의 auto_resumed 처리 및 폴백 동작 검증."""

    async def test_normal_queued(self):
        """auto_resumed 없는 정상 케이스 → start_execution 호출 안 함, ok=True 반환."""
        mock_tm = AsyncMock()
        mock_tm.add_intervention.return_value = {"queue_position": 0}
        mock_tm.executor.start_execution = AsyncMock()

        fn = _unwrap(mcp_tools.send_message_to_session)
        with patch("soul_server.cogito.mcp_session_mgmt.get_task_manager", return_value=mock_tm):
            result = await fn(target_session_id="sess-123", message="hello")

        assert result["ok"] is True
        # F-11A: caller_session_id 미명시 시 caller_info=None 명시 호출 (시그니처 옵션 인자 default).
        mock_tm.add_intervention.assert_called_once_with(
            agent_session_id="sess-123",
            text="hello",
            user="agent",
            caller_info=None,
        )
        mock_tm.executor.start_execution.assert_not_called()

    async def test_auto_resumed_calls_start_execution(self):
        """auto_resumed=True → start_execution 호출, ok=True 반환."""
        mock_tm = AsyncMock()
        mock_tm.add_intervention.return_value = {"auto_resumed": True}
        mock_tm.executor.start_execution = AsyncMock()
        mock_engine = MagicMock()
        mock_rm = MagicMock()

        fn = _unwrap(mcp_tools.send_message_to_session)
        with (
            patch("soul_server.cogito.mcp_session_mgmt.get_task_manager", return_value=mock_tm),
            patch("soul_server.cogito.mcp_session_mgmt.get_soul_engine", return_value=mock_engine),
            patch("soul_server.cogito.mcp_session_mgmt.resource_manager", mock_rm),
        ):
            result = await fn(target_session_id="sess-456", message="resume me")

        assert result["ok"] is True
        mock_tm.executor.start_execution.assert_called_once_with(
            agent_session_id="sess-456",
            claude_runner=mock_engine,
            resource_manager=mock_rm,
        )

    async def test_local_failure_no_orch(self):
        """로컬 add_intervention 예외 + _orch_base=None → ok=False 반환, start_execution 호출 안 함."""
        mock_tm = AsyncMock()
        mock_tm.add_intervention.side_effect = RuntimeError("session not found")
        mock_tm.executor.start_execution = AsyncMock()

        fn = _unwrap(mcp_tools.send_message_to_session)
        with patch("soul_server.cogito.mcp_session_mgmt.get_task_manager", return_value=mock_tm):
            result = await fn(target_session_id="sess-789", message="fail")

        assert result["ok"] is False
        assert "session not found" in result["error"]
        mock_tm.executor.start_execution.assert_not_called()

    async def test_local_failure_with_orch_fallback(self):
        """로컬 실패 + _orch_base 설정 + orchestrator 성공 → ok=True 반환."""
        mock_tm = AsyncMock()
        mock_tm.add_intervention.side_effect = RuntimeError("local error")

        mock_response = MagicMock()
        mock_response.json.return_value = {"queued": True}
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        fn = _unwrap(mcp_tools.send_message_to_session)
        with (
            patch("soul_server.cogito.mcp_session_mgmt.get_task_manager", return_value=mock_tm),
            patch("soul_server.cogito.mcp_session_mgmt.httpx.AsyncClient", return_value=mock_client),
        ):
            mcp_tools._orch_base = "http://orch:3000"
            mcp_multi_node._orch_base = "http://orch:3000"
            mcp_multi_node._orch_headers = {"Authorization": "Bearer test-token"}
            result = await fn(target_session_id="sess-abc", message="via orch")

        assert result["ok"] is True
        mock_client.post.assert_called_once_with(
            "http://orch:3000/api/sessions/sess-abc/intervene",
            json={"text": "via orch", "user": "agent"},
        )

    async def test_orch_fallback_sends_auth_headers(self):
        """오케스트레이터 폴백 시 인증 헤더가 httpx.AsyncClient에 전달되는지 검증."""
        mock_tm = AsyncMock()
        mock_tm.add_intervention.side_effect = RuntimeError("local error")

        mock_response = MagicMock()
        mock_response.json.return_value = {"queued": True}
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        mock_client_cls = MagicMock(return_value=mock_client)

        fn = _unwrap(mcp_tools.send_message_to_session)
        with (
            patch("soul_server.cogito.mcp_session_mgmt.get_task_manager", return_value=mock_tm),
            patch("soul_server.cogito.mcp_session_mgmt.httpx.AsyncClient", mock_client_cls),
        ):
            mcp_tools._orch_base = "http://orch:3000"
            mcp_multi_node._orch_base = "http://orch:3000"
            mcp_multi_node._orch_headers = {"Authorization": "Bearer secret-xyz"}
            result = await fn(target_session_id="sess-auth", message="auth test")

        assert result["ok"] is True
        # httpx.AsyncClient가 인증 헤더와 함께 생성되었는지 검증
        mock_client_cls.assert_called_once_with(
            timeout=10.0,
            headers={"Authorization": "Bearer secret-xyz"},
        )


# ---------------------------------------------------------------------------
# download_session_history
# ---------------------------------------------------------------------------


async def _async_gen_from_list(items):
    """리스트를 AsyncGenerator로 변환하는 헬퍼."""
    for item in items:
        yield item


class TestDownloadSessionHistory:
    async def test_session_not_found(self, session_db, tmp_path):
        fn = _unwrap(mcp_tools.download_session_history)
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=session_db):
            result = await fn("nonexistent", output_dir=str(tmp_path))
        assert "error" in result
        assert "찾을 수 없습니다" in result["error"]

    async def test_empty_session(self, session_db, tmp_path):
        import json

        session_db.stream_events_raw = MagicMock(
            return_value=_async_gen_from_list([])
        )
        fn = _unwrap(mcp_tools.download_session_history)
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=session_db):
            result = await fn("test-sess-001", output_dir=str(tmp_path))

        assert "error" not in result
        assert result["session_id"] == "test-sess-001"
        assert result["event_count"] == 0
        assert (tmp_path / "session_test-sess-001.jsonl").exists()

    async def test_normal(self, session_db, tmp_path):
        import json

        raw_events = [
            (1, "user_message", json.dumps({"type": "user_message", "text": "안녕"})),
            (2, "tool_use", json.dumps({"type": "tool_use", "tool": "Bash"})),
            (3, "result", json.dumps({"type": "result", "result": "완료"})),
        ]
        session_db.stream_events_raw = MagicMock(
            return_value=_async_gen_from_list(raw_events)
        )
        fn = _unwrap(mcp_tools.download_session_history)
        with patch("soul_server.cogito.mcp_session_query.get_session_db", return_value=session_db):
            result = await fn("test-sess-001", output_dir=str(tmp_path))

        assert "error" not in result
        assert result["session_id"] == "test-sess-001"
        assert result["event_count"] == 3

        file_path = tmp_path / "session_test-sess-001.jsonl"
        assert file_path.exists()

        lines = file_path.read_text(encoding="utf-8").splitlines()
        assert len(lines) == 3

        first = json.loads(lines[0])
        assert first["id"] == 1
        assert first["event_type"] == "user_message"
        assert first["event"]["text"] == "안녕"

        last = json.loads(lines[2])
        assert last["id"] == 3
        assert last["event_type"] == "result"
        assert last["event"]["result"] == "완료"


# ---------------------------------------------------------------------------
# mcp_multi_node.init — auth header capture
# ---------------------------------------------------------------------------


class TestMultiNodeInit:
    """mcp_multi_node.init()이 인증 헤더를 올바르게 캡처하는지 검증."""

    def test_init_captures_auth_token(self):
        """settings.auth_bearer_token이 있으면 _orch_headers에 Bearer 헤더가 설정된다."""
        settings = MagicMock()
        settings.soulstream_upstream_url = "wss://orch.example.com/ws/node1"
        settings.auth_bearer_token = "my-secret-token"

        mcp_multi_node.init(settings)

        assert mcp_multi_node._orch_base == "https://orch.example.com"
        assert mcp_multi_node._orch_headers == {
            "Authorization": "Bearer my-secret-token"
        }

    def test_init_no_token(self):
        """settings.auth_bearer_token이 빈 문자열이면 _orch_headers는 빈 dict."""
        settings = MagicMock()
        settings.soulstream_upstream_url = "ws://localhost:5200/ws/node1"
        settings.auth_bearer_token = ""

        mcp_multi_node.init(settings)

        assert mcp_multi_node._orch_base == "http://localhost:5200"
        assert mcp_multi_node._orch_headers == {}

    def test_init_no_token_attr(self):
        """settings에 auth_bearer_token 속성이 없으면 _orch_headers는 빈 dict."""
        settings = MagicMock(spec=[])
        settings.soulstream_upstream_url = "wss://orch.example.com/ws/node1"

        mcp_multi_node.init(settings)

        assert mcp_multi_node._orch_headers == {}
