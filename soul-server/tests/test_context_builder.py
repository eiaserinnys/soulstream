"""
test_context_builder - build_soulstream_context_item()의 caller_info 주입 검증 (Phase 1)
"""

from soul_server.service.context_builder import build_soulstream_context_item


class TestBuildSoulstreamContextItem:
    def test_caller_info_omitted_when_none(self):
        """caller_info=None이면 content dict에 caller_info 키가 존재하지 않는다."""
        item = build_soulstream_context_item(
            agent_session_id="sess-1",
            claude_session_id=None,
            workspace_dir="/tmp/ws",
            caller_info=None,
        )
        assert item["key"] == "soulstream_session"
        assert "caller_info" not in item["content"]

    def test_caller_info_default_value_is_none(self):
        """caller_info 인자를 생략하면 None으로 취급되어 키가 생략된다 (기본값 호환)."""
        item = build_soulstream_context_item(
            agent_session_id="sess-1",
            claude_session_id=None,
            workspace_dir="/tmp/ws",
        )
        assert "caller_info" not in item["content"]

    def test_caller_info_injected_when_provided(self):
        """caller_info dict 전달 시 content에 그대로 포함된다."""
        info = {
            "source": "slack",
            "ip": "10.0.0.1",
            "slack": {"channel_id": "C1", "user_id": "U1"},
        }
        item = build_soulstream_context_item(
            agent_session_id="sess-1",
            claude_session_id=None,
            workspace_dir="/tmp/ws",
            caller_info=info,
        )
        assert item["content"]["caller_info"] == info

    def test_caller_info_empty_dict_is_omitted(self):
        """caller_info가 빈 dict이면 truthy 체크에서 제외되어 키가 생략된다 (에지 케이스)."""
        item = build_soulstream_context_item(
            agent_session_id="sess-1",
            claude_session_id=None,
            workspace_dir="/tmp/ws",
            caller_info={},
        )
        assert "caller_info" not in item["content"]
