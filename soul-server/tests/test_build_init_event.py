"""_build_init_event 헬퍼 단위 테스트"""

import json
from unittest.mock import patch, MagicMock


def test_build_init_event_includes_node_id():
    """node_id가 설정되어 있으면 init 이벤트에 포함된다."""
    mock_settings = MagicMock()
    mock_settings.soulstream_node_id = "silent-manari"

    with patch("soul_server.api.tasks.get_settings", return_value=mock_settings):
        from soul_server.api.tasks import _build_init_event

        result = _build_init_event("sess-123")

    assert result["event"] == "init"
    data = json.loads(result["data"])
    assert data["type"] == "init"
    assert data["agent_session_id"] == "sess-123"
    assert data["node_id"] == "silent-manari"


def test_build_init_event_omits_node_id_when_empty():
    """node_id가 빈 문자열이면 init 이벤트에 포함하지 않는다."""
    mock_settings = MagicMock()
    mock_settings.soulstream_node_id = ""

    with patch("soul_server.api.tasks.get_settings", return_value=mock_settings):
        from soul_server.api.tasks import _build_init_event

        result = _build_init_event("sess-456")

    data = json.loads(result["data"])
    assert data["type"] == "init"
    assert data["agent_session_id"] == "sess-456"
    assert "node_id" not in data
