"""
test_engine_adapter_context - context_items 관련 함수 유닛 테스트

커버리지 시나리오:
_format_context_items:
  1. 정상 key → XML 태그로 사용
  2. 특수문자 key → 밑줄로 sanitize
  3. 빈 key → 'item' fallback
  4. dict content → JSON 직렬화
  5. string content → 그대로 포함

build_soulstream_context_item:
  6. 반환값에 key, label, content 필드 존재
  7. claude_session_id=None → '(new session)' 기록
"""

import json
from unittest.mock import MagicMock, patch

import pytest

from soul_server.service.engine_adapter import (
    build_soulstream_context_item,
    _format_context_items,
)


class TestFormatContextItems:
    """_format_context_items 함수 테스트."""

    def test_normal_key_becomes_xml_tag(self):
        """정상 key는 그대로 XML 태그명으로 사용된다."""
        items = [{"key": "soulstream_session", "content": "hello"}]
        result = _format_context_items(items)
        assert "<soulstream_session>" in result
        assert "</soulstream_session>" in result
        assert "hello" in result

    def test_special_char_key_sanitized(self):
        """영문/숫자/밑줄 외 특수문자는 밑줄로 치환된다."""
        items = [{"key": "a-b:c", "content": "x"}]
        result = _format_context_items(items)
        assert "<a_b_c>" in result
        assert "</a_b_c>" in result
        # 원본 특수문자 key가 태그에 포함되지 않는다
        assert "<a-b:c>" not in result

    def test_empty_key_falls_back_to_item(self):
        """빈 key는 'item'으로 대체된다."""
        items = [{"key": "", "content": "x"}]
        result = _format_context_items(items)
        assert "<item>" in result
        assert "</item>" in result

    def test_dict_content_serialized_as_json(self):
        """dict content는 ensure_ascii=False, indent=2 JSON으로 직렬화된다."""
        content = {"name": "서소영", "value": 42}
        items = [{"key": "test", "content": content}]
        result = _format_context_items(items)
        expected = json.dumps(content, ensure_ascii=False, indent=2)
        assert expected in result

    def test_string_content_included_as_is(self):
        """string content는 변환 없이 그대로 포함된다."""
        items = [{"key": "test", "content": "plain text 한글"}]
        result = _format_context_items(items)
        assert "plain text 한글" in result

    def test_output_wrapped_in_context_tag(self):
        """출력 전체는 <context> 태그로 감싸진다."""
        items = [{"key": "k", "content": "v"}]
        result = _format_context_items(items)
        assert result.startswith("<context>")
        assert result.endswith("</context>")


def _call_build(
    agent_session_id="sess-001",
    claude_session_id=None,
    workspace_dir="/workspace",
    folder_name=None,
    node_id=None,
    agent_id=None,
) -> dict:
    """build_soulstream_context_item 호출 헬퍼 (socket/platform/settings mock 포함)."""
    mock_socket_instance = MagicMock()
    mock_socket_instance.getsockname.return_value = ("10.0.0.1", 80)

    mock_socket_module = MagicMock()
    mock_socket_module.gethostname.return_value = "test-host"
    mock_socket_module.socket.return_value = mock_socket_instance
    mock_socket_module.AF_INET = 2
    mock_socket_module.SOCK_DGRAM = 2

    mock_platform = MagicMock()
    mock_platform.system.return_value = "Linux"
    mock_platform.version.return_value = "#1 SMP"

    mock_settings = MagicMock()
    mock_settings.soulstream_node_id = "test-node"

    with patch("soul_server.service.engine_adapter.socket", mock_socket_module), \
         patch("soul_server.service.engine_adapter.platform", mock_platform), \
         patch("soul_server.service.engine_adapter.get_settings", return_value=mock_settings):
        return build_soulstream_context_item(
            agent_session_id, claude_session_id, workspace_dir,
            folder_name=folder_name, node_id=node_id, agent_id=agent_id,
        )


class TestBuildSoulsreamContextItem:
    """build_soulstream_context_item 함수 테스트."""

    def test_required_top_level_fields_present(self):
        """반환값에 key, label, content 필드가 존재한다."""
        item = _call_build()
        assert "key" in item
        assert "label" in item
        assert "content" in item

    def test_content_contains_all_required_fields(self):
        """content에 세션 메타데이터 필드가 모두 포함된다."""
        item = _call_build(agent_session_id="sess-001", workspace_dir="/work")
        content = item["content"]
        assert content["agent_session_id"] == "sess-001"
        assert "claude_session_id" in content
        assert content["workspace_dir"] == "/work"
        assert "hostname" in content
        assert "ip_address" in content
        assert "current_time" in content
        assert "current_node_id" in content
        assert "host_os" in content
        assert "os_version" in content

    def test_current_time_is_iso8601_utc(self):
        """current_time이 ISO 8601 UTC 형식이다."""
        from datetime import datetime, timezone
        item = _call_build()
        current_time = item["content"]["current_time"]
        # ISO 8601 파싱 가능한지 확인
        parsed = datetime.fromisoformat(current_time)
        assert parsed.tzinfo is not None  # timezone-aware

    def test_none_claude_session_id_becomes_new_session(self):
        """claude_session_id=None이면 content에 '(new session)'이 기록된다."""
        item = _call_build(claude_session_id=None)
        assert item["content"]["claude_session_id"] == "(new session)"

    def test_provided_claude_session_id_preserved(self):
        """claude_session_id가 제공되면 그대로 기록된다."""
        item = _call_build(claude_session_id="claude-abc123")
        assert item["content"]["claude_session_id"] == "claude-abc123"

    def test_host_os_and_version_from_platform(self):
        """host_os와 os_version이 platform 모듈에서 가져온 값으로 설정된다."""
        item = _call_build()
        content = item["content"]
        assert content["host_os"] == "Linux"
        assert content["os_version"] == "#1 SMP"

    def test_current_node_id_from_explicit_param(self):
        """node_id 파라미터가 명시되면 current_node_id에 그대로 기록된다."""
        item = _call_build(node_id="my-node")
        assert item["content"]["current_node_id"] == "my-node"

    def test_current_node_id_from_settings_when_not_passed(self):
        """node_id가 None이면 settings.soulstream_node_id 값이 사용된다."""
        item = _call_build(node_id=None)
        # _call_build 헬퍼가 settings mock에 "test-node"를 설정함
        assert item["content"]["current_node_id"] == "test-node"

    def test_agent_id_included_when_provided(self):
        """agent_id가 제공되면 content에 포함된다."""
        item = _call_build(agent_id="profile-abc")
        assert item["content"]["agent_id"] == "profile-abc"

    def test_agent_id_absent_when_none(self):
        """agent_id=None이면 content에 agent_id 필드가 없다."""
        item = _call_build(agent_id=None)
        assert "agent_id" not in item["content"]
