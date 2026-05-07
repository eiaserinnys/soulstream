"""format_atom_context 단위 테스트"""
import pytest
from soul_server.service.atom_context import format_atom_context, _ATOM_CONTEXT_HEADER


class TestFormatAtomContext:
    def test_header_prepended(self):
        """헤더 줄이 첫 번째 줄에 포함된다."""
        result = format_atom_context(
            "soulstream <!-- node:d71af4b5-c53a-49a4-9e07-9b6ee531fb56"
            " card:7eeba4cc-feed-feed-feed-feedfeedffff depth:0 chars:123 -->"
        )
        assert result.startswith(_ATOM_CONTEXT_HEADER)

    def test_html_comment_replaced(self):
        """HTML 주석이 [node:X card:Y] (N chars) 포맷으로 변환된다 (두 ID 보존)."""
        line = (
            "soulstream <!-- node:d71af4b5-c53a-49a4-9e07-9b6ee531fb56"
            " card:7eeba4cc-feed-feed-feed-feedfeedffff depth:0"
            " created:2026-04-02 chars:123 -->"
        )
        result = format_atom_context(line)
        assert (
            "[node:d71af4b5-c53a-49a4-9e07-9b6ee531fb56"
            " card:7eeba4cc-feed-feed-feed-feedfeedffff] (123 chars)"
        ) in result
        assert "<!--" not in result

    def test_symlink_node_comment_replaced(self):
        """symlink 노드(chars 뒤 symlink:true 필드)도 정상 변환되고 ~ 마커가 보존된다."""
        line = (
            "  ├── ~ 심링크 <!-- node:a1b2c3d4-0000-0000-0000-000000000000"
            " card:b2c3d4e5-aaaa-bbbb-cccc-dddddddddddd depth:2"
            " chars:0 symlink:true -->"
        )
        result = format_atom_context(line)
        assert (
            "~ 심링크 [node:a1b2c3d4-0000-0000-0000-000000000000"
            " card:b2c3d4e5-aaaa-bbbb-cccc-dddddddddddd] (0 chars)"
        ) in result
        assert "<!--" not in result

    def test_no_comment_passthrough(self):
        """HTML 주석 없는 줄은 원본 그대로 통과한다."""
        plain_line = "  ├── 일반 텍스트 (no comment)"
        result = format_atom_context(plain_line)
        assert plain_line in result

    # ---- 신규 6건 (260507 — atom PR #10 정합) ----

    def test_heading_mode_two_ids_preserved(self):
        """heading 모드(chars 없음) — 두 ID 라벨로 치환된다."""
        line = (
            "## 시스템 <!-- node:11111111-2222-3333-4444-555555555555"
            " card:66666666-7777-8888-9999-aaaaaaaaaaaa depth:1"
            " created:2026-04-01 -->"
        )
        result = format_atom_context(line)
        assert (
            "[node:11111111-2222-3333-4444-555555555555"
            " card:66666666-7777-8888-9999-aaaaaaaaaaaa]"
        ) in result
        assert "<!--" not in result

    def test_titles_only_two_ids_with_chars(self):
        """titles_only 모드(chars 있음) — 두 ID + chars."""
        line = (
            "├── 시스템 <!-- node:11111111-2222-3333-4444-555555555555"
            " card:66666666-7777-8888-9999-aaaaaaaaaaaa depth:1 chars:42 -->"
        )
        result = format_atom_context(line)
        assert (
            "[node:11111111-2222-3333-4444-555555555555"
            " card:66666666-7777-8888-9999-aaaaaaaaaaaa] (42 chars)"
        ) in result

    def test_idempotent_short_label(self):
        """짧은 라벨이 이미 박힌 라인은 변경되지 않는다 (idempotent)."""
        line = (
            "├── 시스템 [node:11111111-2222-3333-4444-555555555555"
            " card:66666666-7777-8888-9999-aaaaaaaaaaaa] (42 chars)"
        )
        result = format_atom_context(line)
        # 헤더가 prepend된 후 본문 라인은 원본 그대로
        assert line in result
        # 라벨이 중복되지 않음
        assert result.count("[node:11111111") == 1

    def test_cycle_marker_passthrough(self):
        """*(cycle)* 마커 라인은 변경되지 않는다."""
        line = "├── 순환 *(cycle)*"
        result = format_atom_context(line)
        assert line in result

    def test_legacy_node_only_comment(self):
        """구 호환 — card:Y 없는 단일 ID 형태는 [X] (N chars)로 폴백."""
        line = "├── 옛날 <!-- node:cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa chars:7 -->"
        result = format_atom_context(line)
        assert "[cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa] (7 chars)" in result
        assert "<!--" not in result

    def test_idempotent_full_pass(self):
        """format_atom_context를 두 번 적용해도 본문 라벨이 중복되지 않는다.

        헤더는 두 번 prepend되지만 (이는 함수 명세 — caller가 중복 호출하지 않음),
        본문의 ID 라벨 자체는 idempotent하게 유지된다.
        """
        original = (
            "├── 시스템 <!-- node:11111111-2222-3333-4444-555555555555"
            " card:66666666-7777-8888-9999-aaaaaaaaaaaa depth:1 chars:42 -->"
        )
        once = format_atom_context(original)
        twice = format_atom_context(once)
        # 본문 라벨이 정확히 한 번만 등장
        assert twice.count(
            "[node:11111111-2222-3333-4444-555555555555"
            " card:66666666-7777-8888-9999-aaaaaaaaaaaa] (42 chars)"
        ) == 1
        # 잔여 HTML 주석 없음
        assert "<!--" not in twice
