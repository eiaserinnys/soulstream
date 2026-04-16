"""format_atom_context 단위 테스트"""
import pytest
from soul_server.service.atom_context import format_atom_context, _ATOM_CONTEXT_HEADER


class TestFormatAtomContext:
    def test_header_prepended(self):
        """헤더 줄이 첫 번째 줄에 포함된다."""
        result = format_atom_context(
            "soulstream <!-- node:d71af4b5-0000-0000-0000-000000000000 card:abc depth:0 chars:123 -->"
        )
        assert result.startswith(_ATOM_CONTEXT_HEADER)

    def test_html_comment_replaced(self):
        """HTML 주석이 [node_id] (N chars) 포맷으로 변환된다."""
        line = "soulstream <!-- node:d71af4b5-c53a-49a4-9e07-9b6ee531fb56 card:7eeba4cc-0000 depth:0 created:2026-04-02 chars:123 -->"
        result = format_atom_context(line)
        assert "[d71af4b5-c53a-49a4-9e07-9b6ee531fb56] (123 chars)" in result
        assert "<!--" not in result

    def test_symlink_node_comment_replaced(self):
        """symlink 노드(chars 뒤 symlink:true 필드)도 정상 변환된다."""
        line = "  ├── ~ 심링크 <!-- node:a1b2c3d4-0000-0000-0000-000000000000 card:abc depth:2 chars:0 symlink:true -->"
        result = format_atom_context(line)
        assert "[a1b2c3d4-0000-0000-0000-000000000000] (0 chars)" in result
        assert "<!--" not in result

    def test_no_comment_passthrough(self):
        """HTML 주석 없는 줄은 원본 그대로 통과한다."""
        plain_line = "  ├── 일반 텍스트 (no comment)"
        result = format_atom_context(plain_line)
        assert plain_line in result
