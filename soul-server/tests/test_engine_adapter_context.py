"""
test_engine_adapter_context - context_items 관련 함수 유닛 테스트

커버리지 시나리오:
_format_context_items:
  1. 정상 key → XML 태그로 사용
  2. 특수문자 key → 밑줄로 sanitize
  3. 빈 key → 'item' fallback
  4. dict content → JSON 직렬화
  5. string content → 그대로 포함

_build_soulstream_context_item:
  6. 반환값에 key, label, content 필드 존재
  7. claude_session_id=None → '(new session)' 기록
"""

import json
from unittest.mock import MagicMock, patch

import pytest

from soul_server.service.engine_adapter import (
    _build_soulstream_context_item,
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
) -> dict:
    """_build_soulstream_context_item 호출 헬퍼 (socket mock 포함)."""
    mock_socket_instance = MagicMock()
    mock_socket_instance.getsockname.return_value = ("10.0.0.1", 80)

    mock_socket_module = MagicMock()
    mock_socket_module.gethostname.return_value = "test-host"
    mock_socket_module.socket.return_value = mock_socket_instance
    mock_socket_module.AF_INET = 2
    mock_socket_module.SOCK_DGRAM = 2

    with patch("soul_server.service.engine_adapter.socket", mock_socket_module):
        return _build_soulstream_context_item(agent_session_id, claude_session_id, workspace_dir)


class TestBuildSoulsreamContextItem:
    """_build_soulstream_context_item 함수 테스트."""

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

    def test_none_claude_session_id_becomes_new_session(self):
        """claude_session_id=None이면 content에 '(new session)'이 기록된다."""
        item = _call_build(claude_session_id=None)
        assert item["content"]["claude_session_id"] == "(new session)"

    def test_provided_claude_session_id_preserved(self):
        """claude_session_id가 제공되면 그대로 기록된다."""
        item = _call_build(claude_session_id="claude-abc123")
        assert item["content"]["claude_session_id"] == "claude-abc123"
