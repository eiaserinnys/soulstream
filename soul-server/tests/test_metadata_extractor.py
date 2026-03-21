"""MetadataExtractor 단위 테스트

Phase 2: Tool Result 훅 + 설정 가능한 규칙
- YAML 규칙 로드
- regex 모드 추출
- json 모드 추출
- is_error 무시
- 매칭 없음 케이스
"""

import json
from pathlib import Path

import pytest

from soul_server.service.metadata_extractor import MetadataExtractor


@pytest.fixture
def rules_path(tmp_path):
    """범용 규칙만 포함하는 테스트용 YAML (소스 리포 기본값과 동일)"""
    rules = tmp_path / "rules.yaml"
    rules.write_text(
        """
rules:
  - name: git_commit
    tool_name: Bash
    result_mode: regex
    result_pattern: "\\\\[([a-f0-9]{7,12})\\\\]\\\\s+(.+)"
    extract:
      type: git_commit
      value: "$1"
      label: "$2"

  - name: git_branch_create
    tool_name: Bash
    result_mode: regex
    result_pattern: "Switched to a new branch '([^']+)'"
    extract:
      type: git_branch_create
      value: "$1"

  - name: git_worktree_add
    tool_name: Bash
    result_mode: regex
    result_pattern: "Preparing worktree \\\\(new branch '([^']+)'\\\\)"
    extract:
      type: git_worktree_create
      value: "$1"

  - name: git_branch_delete
    tool_name: Bash
    result_mode: regex
    result_pattern: "Deleted branch ([^ ]+)"
    extract:
      type: git_branch_delete
      value: "$1"

  - name: git_worktree_remove
    tool_name: Bash
    result_mode: regex
    result_pattern: "(?:Removing worktree|worktree .+ removed)"
    extract:
      type: git_worktree_remove
      value: "worktree removed"

  - name: file_write
    tool_name: Write
    result_mode: regex
    result_pattern: "File created successfully at:\\\\s*(.+)"
    extract:
      type: file_write
      value: "$1"

  - name: file_edit
    tool_name: Edit
    result_mode: regex
    result_pattern: "The file (.+) has been updated"
    extract:
      type: file_edit
      value: "$1"
""",
        encoding="utf-8",
    )
    return rules


@pytest.fixture
def specialized_rules_path(tmp_path):
    """환경 특화 규칙을 포함하는 테스트용 YAML (배포 환경에서 사용)"""
    rules = tmp_path / "specialized_rules.yaml"
    rules.write_text(
        """
rules:
  - name: trello_card_create
    tool_name: mcp__trello__add_card_to_list
    result_mode: json
    extract:
      type: trello_card
      value: "$.id"
      label: "$.name"
      url: "$.url"

  - name: trello_card_move
    tool_name: mcp__trello__move_card
    result_mode: json
    extract:
      type: trello_card_move
      value: "$.id"
      label: "$.name"
      url: "$.url"

  - name: serendipity_page
    tool_name: mcp__serendipity__create_page
    result_mode: json
    extract:
      type: serendipity_page
      value: "$.id"
      label: "$.title"

  - name: serendipity_page_update
    tool_name: mcp__serendipity__update_page
    result_mode: json
    extract:
      type: serendipity_page_update
      value: "$.id"
      label: "$.title"

  - name: serendipity_block_create
    tool_name: mcp__serendipity__create_block
    result_mode: json
    extract:
      type: serendipity_block
      value: "$.id"
      label: "$.type"

  - name: serendipity_block_update
    tool_name: mcp__serendipity__update_block
    result_mode: json
    extract:
      type: serendipity_block
      value: "$.id"
      label: "$.type"
""",
        encoding="utf-8",
    )
    return rules


@pytest.fixture
def extractor(rules_path):
    return MetadataExtractor(rules_path)


@pytest.fixture
def specialized_extractor(specialized_rules_path):
    return MetadataExtractor(specialized_rules_path)


# ============================================================
# 초기화
# ============================================================


class TestInit:
    def test_load_universal_rules(self, extractor):
        """범용 규칙 로드 성공"""
        assert len(extractor._rules) == 7

    def test_load_specialized_rules(self, specialized_extractor):
        """특화 규칙 로드 성공"""
        assert len(specialized_extractor._rules) == 6

    def test_file_not_found(self, tmp_path):
        """존재하지 않는 규칙 파일"""
        with pytest.raises(FileNotFoundError):
            MetadataExtractor(tmp_path / "nonexistent.yaml")


# ============================================================
# regex 모드
# ============================================================


class TestRegexMode:
    def test_git_commit(self, extractor):
        """git commit 메시지에서 해시와 메시지 추출"""
        result = "[c8a40c6] feat: add metadata support"
        entry = extractor.extract("Bash", result, is_error=False)

        assert entry is not None
        assert entry["type"] == "git_commit"
        assert entry["value"] == "c8a40c6"
        assert entry["label"] == "feat: add metadata support"
        assert entry["tool_name"] == "Bash"
        assert "timestamp" in entry

    def test_git_commit_in_multiline(self, extractor):
        """여러 줄 출력에서 git commit 추출"""
        result = "Some prefix\n[abc1234def] fix: something\nSome suffix"
        entry = extractor.extract("Bash", result, is_error=False)

        assert entry is not None
        assert entry["value"] == "abc1234def"

    def test_git_branch_create(self, extractor):
        """git branch 생성 감지"""
        result = "Switched to a new branch 'feature/auth'"
        entry = extractor.extract("Bash", result, is_error=False)

        assert entry is not None
        assert entry["type"] == "git_branch_create"
        assert entry["value"] == "feature/auth"

    def test_git_worktree_add(self, extractor):
        """git worktree 생성 감지"""
        result = "Preparing worktree (new branch 'feature/metadata')\nHEAD is now at abc1234"
        entry = extractor.extract("Bash", result, is_error=False)

        assert entry is not None
        assert entry["type"] == "git_worktree_create"
        assert entry["value"] == "feature/metadata"

    def test_no_match(self, extractor):
        """매칭되지 않는 Bash 결과"""
        result = "just some normal output"
        entry = extractor.extract("Bash", result, is_error=False)
        assert entry is None

    def test_git_branch_delete(self, extractor):
        """git branch 삭제 감지"""
        result = "Deleted branch feature/old-branch (was abc1234)."
        entry = extractor.extract("Bash", result, is_error=False)

        assert entry is not None
        assert entry["type"] == "git_branch_delete"
        assert entry["value"] == "feature/old-branch"

    def test_git_worktree_remove(self, extractor):
        """git worktree 삭제 감지"""
        result = "Removing worktree"
        entry = extractor.extract("Bash", result, is_error=False)

        assert entry is not None
        assert entry["type"] == "git_worktree_remove"

    def test_git_worktree_remove_empty_output(self, extractor):
        """git worktree remove 빈 출력 시 매칭 실패"""
        result = ""
        entry = extractor.extract("Bash", result, is_error=False)
        assert entry is None

    def test_file_write(self, extractor):
        """Write 도구 결과에서 파일 경로 추출"""
        result = "File created successfully at: D:\\project\\src\\main.py"
        entry = extractor.extract("Write", result, is_error=False)

        assert entry is not None
        assert entry["type"] == "file_write"
        assert entry["value"] == "D:\\project\\src\\main.py"

    def test_file_edit(self, extractor):
        """Edit 도구 결과에서 파일 경로 추출"""
        result = "The file D:\\soyoung_root\\soulstream_runtime\\.env has been updated successfully."
        entry = extractor.extract("Edit", result, is_error=False)

        assert entry is not None
        assert entry["type"] == "file_edit"
        assert entry["value"] == "D:\\soyoung_root\\soulstream_runtime\\.env"

    def test_first_match_wins(self, extractor):
        """git commit과 branch 모두 포함 시 첫 번째 매칭"""
        # git_commit 규칙이 git_branch_create보다 앞에 있음
        result = "[abc1234] Switched to a new branch 'feature/x'"
        entry = extractor.extract("Bash", result, is_error=False)

        assert entry is not None
        assert entry["type"] == "git_commit"


# ============================================================
# json 모드
# ============================================================


class TestJsonMode:
    """범용 extractor에는 JSON 모드 규칙이 없으므로, 특화 extractor로 테스트"""

    def test_trello_card(self, specialized_extractor):
        """Trello 카드 생성 결과에서 추출"""
        result = json.dumps({
            "id": "card-123",
            "name": "Phase 1 카드",
            "url": "https://trello.com/c/abc123",
        })
        entry = specialized_extractor.extract("mcp__trello__add_card_to_list", result, is_error=False)

        assert entry is not None
        assert entry["type"] == "trello_card"
        assert entry["value"] == "card-123"
        assert entry["label"] == "Phase 1 카드"
        assert entry["url"] == "https://trello.com/c/abc123"

    def test_serendipity_page(self, specialized_extractor):
        """세렌디피티 페이지 생성 결과에서 추출"""
        result = json.dumps({
            "id": "page-uuid-123",
            "title": "작업 문서",
        })
        entry = specialized_extractor.extract("mcp__serendipity__create_page", result, is_error=False)

        assert entry is not None
        assert entry["type"] == "serendipity_page"
        assert entry["value"] == "page-uuid-123"
        assert entry["label"] == "작업 문서"

    def test_invalid_json(self, specialized_extractor):
        """잘못된 JSON 결과"""
        entry = specialized_extractor.extract("mcp__trello__add_card_to_list", "not json", is_error=False)
        assert entry is None

    def test_trello_card_move(self, specialized_extractor):
        """Trello 카드 이동 결과에서 추출"""
        result = json.dumps({
            "id": "card-456",
            "name": "Phase 2",
            "url": "https://trello.com/c/xyz",
        })
        entry = specialized_extractor.extract("mcp__trello__move_card", result, is_error=False)

        assert entry is not None
        assert entry["type"] == "trello_card_move"
        assert entry["value"] == "card-456"
        assert entry["label"] == "Phase 2"

    def test_serendipity_page_update(self, specialized_extractor):
        """세렌디피티 페이지 갱신 결과에서 추출"""
        result = json.dumps({
            "id": "page-uuid",
            "title": "Updated Doc",
        })
        entry = specialized_extractor.extract("mcp__serendipity__update_page", result, is_error=False)

        assert entry is not None
        assert entry["type"] == "serendipity_page_update"
        assert entry["value"] == "page-uuid"
        assert entry["label"] == "Updated Doc"

    def test_serendipity_block_create(self, specialized_extractor):
        """세렌디피티 블록 생성 결과에서 추출"""
        result = json.dumps({
            "id": "block-uuid",
            "type": "paragraph",
        })
        entry = specialized_extractor.extract("mcp__serendipity__create_block", result, is_error=False)

        assert entry is not None
        assert entry["type"] == "serendipity_block"
        assert entry["value"] == "block-uuid"
        assert entry["label"] == "paragraph"

    def test_serendipity_block_update(self, specialized_extractor):
        """세렌디피티 블록 갱신 결과에서 추출"""
        result = json.dumps({
            "id": "block-uuid-2",
            "type": "heading",
        })
        entry = specialized_extractor.extract("mcp__serendipity__update_block", result, is_error=False)

        assert entry is not None
        assert entry["type"] == "serendipity_block"
        assert entry["value"] == "block-uuid-2"

    def test_missing_required_field(self, specialized_extractor):
        """필수 필드(value 경로) 누락"""
        result = json.dumps({"name": "test"})  # id 없음
        entry = specialized_extractor.extract("mcp__trello__add_card_to_list", result, is_error=False)
        assert entry is None


# ============================================================
# MCP content block unwrap
# ============================================================


class TestMcpContentBlockUnwrap:
    """MCP 도구 결과가 [{"type":"text","text":"..."}] 형태로 래핑될 때 unwrap"""

    def test_mcp_wrapped_trello_card(self, specialized_extractor):
        """MCP 래핑된 Trello 카드 생성 결과에서 추출"""
        inner_json = json.dumps({
            "id": "card-mcp-123",
            "name": "MCP 래핑 카드",
            "url": "https://trello.com/c/mcp123",
        })
        # MCP content block 형태로 래핑
        result = json.dumps([{"type": "text", "text": inner_json}])
        entry = specialized_extractor.extract(
            "mcp__trello__add_card_to_list", result, is_error=False
        )

        assert entry is not None
        assert entry["type"] == "trello_card"
        assert entry["value"] == "card-mcp-123"
        assert entry["label"] == "MCP 래핑 카드"
        assert entry["url"] == "https://trello.com/c/mcp123"

    def test_mcp_wrapped_serendipity_page(self, specialized_extractor):
        """MCP 래핑된 세렌디피티 페이지 생성 결과에서 추출"""
        inner_json = json.dumps({
            "id": "page-mcp-uuid",
            "title": "MCP 래핑 문서",
        })
        result = json.dumps([{"type": "text", "text": inner_json}])
        entry = specialized_extractor.extract(
            "mcp__serendipity__create_page", result, is_error=False
        )

        assert entry is not None
        assert entry["type"] == "serendipity_page"
        assert entry["value"] == "page-mcp-uuid"
        assert entry["label"] == "MCP 래핑 문서"

    def test_mcp_wrapped_invalid_inner_json(self, specialized_extractor):
        """MCP 래핑 내부에 유효하지 않은 JSON"""
        result = json.dumps([{"type": "text", "text": "not valid json"}])
        entry = specialized_extractor.extract(
            "mcp__trello__add_card_to_list", result, is_error=False
        )
        assert entry is None

    def test_mcp_wrapped_missing_required_field(self, specialized_extractor):
        """MCP 래핑된 JSON에 필수 필드 누락"""
        inner_json = json.dumps({"name": "no id"})
        result = json.dumps([{"type": "text", "text": inner_json}])
        entry = specialized_extractor.extract(
            "mcp__trello__add_card_to_list", result, is_error=False
        )
        assert entry is None

    def test_plain_json_still_works(self, specialized_extractor):
        """래핑 없는 일반 JSON도 여전히 동작"""
        result = json.dumps({
            "id": "card-plain",
            "name": "일반 카드",
            "url": "https://trello.com/c/plain",
        })
        entry = specialized_extractor.extract(
            "mcp__trello__add_card_to_list", result, is_error=False
        )
        assert entry is not None
        assert entry["value"] == "card-plain"

    def test_mcp_wrapped_multiple_blocks_ignored(self, specialized_extractor):
        """MCP content block이 2개 이상이면 unwrap하지 않음"""
        inner1 = json.dumps({"id": "1", "name": "a", "url": "u"})
        inner2 = json.dumps({"id": "2", "name": "b", "url": "v"})
        result = json.dumps([
            {"type": "text", "text": inner1},
            {"type": "text", "text": inner2},
        ])
        entry = specialized_extractor.extract(
            "mcp__trello__add_card_to_list", result, is_error=False
        )
        assert entry is None


# ============================================================
# is_error 처리
# ============================================================


class TestIsError:
    def test_is_error_skips(self, extractor):
        """is_error=True이면 즉시 None"""
        result = "[abc1234] feat: something"
        entry = extractor.extract("Bash", result, is_error=True)
        assert entry is None

    def test_is_error_false_processes(self, extractor):
        """is_error=False이면 정상 처리"""
        result = "[abc1234] feat: something"
        entry = extractor.extract("Bash", result, is_error=False)
        assert entry is not None


# ============================================================
# tool_name 매칭
# ============================================================


class TestToolNameMatching:
    def test_wrong_tool_name(self, extractor):
        """다른 도구 이름은 매칭 안 됨"""
        result = json.dumps({"id": "123", "name": "test"})
        entry = extractor.extract("some_other_tool", result, is_error=False)
        assert entry is None

    def test_regex_tool_name(self, tmp_path):
        """tool_name_regex 모드"""
        rules = tmp_path / "regex_rules.yaml"
        rules.write_text(
            """
rules:
  - name: any_mcp_create
    tool_name: "mcp__.*__create.*"
    tool_name_regex: true
    result_mode: json
    extract:
      type: mcp_create
      value: "$.id"
""",
            encoding="utf-8",
        )
        ext = MetadataExtractor(rules)
        result = json.dumps({"id": "new-item-123"})

        entry = ext.extract("mcp__arbor__create_item", result, is_error=False)
        assert entry is not None
        assert entry["type"] == "mcp_create"
        assert entry["value"] == "new-item-123"
