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
    """테스트용 규칙 YAML 생성"""
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

  - name: trello_card_create
    tool_name: mcp__trello__add_card_to_list
    result_mode: json
    extract:
      type: trello_card
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
""",
        encoding="utf-8",
    )
    return rules


@pytest.fixture
def extractor(rules_path):
    return MetadataExtractor(rules_path)


# ============================================================
# 초기화
# ============================================================


class TestInit:
    def test_load_rules(self, extractor):
        """규칙 로드 성공"""
        assert len(extractor._rules) == 5

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
    def test_trello_card(self, extractor):
        """Trello 카드 생성 결과에서 추출"""
        result = json.dumps({
            "id": "card-123",
            "name": "Phase 1 카드",
            "url": "https://trello.com/c/abc123",
        })
        entry = extractor.extract("mcp__trello__add_card_to_list", result, is_error=False)

        assert entry is not None
        assert entry["type"] == "trello_card"
        assert entry["value"] == "card-123"
        assert entry["label"] == "Phase 1 카드"
        assert entry["url"] == "https://trello.com/c/abc123"

    def test_serendipity_page(self, extractor):
        """세렌디피티 페이지 생성 결과에서 추출"""
        result = json.dumps({
            "id": "page-uuid-123",
            "title": "작업 문서",
        })
        entry = extractor.extract("mcp__serendipity__create_page", result, is_error=False)

        assert entry is not None
        assert entry["type"] == "serendipity_page"
        assert entry["value"] == "page-uuid-123"
        assert entry["label"] == "작업 문서"

    def test_invalid_json(self, extractor):
        """잘못된 JSON 결과"""
        entry = extractor.extract("mcp__trello__add_card_to_list", "not json", is_error=False)
        assert entry is None

    def test_missing_required_field(self, extractor):
        """필수 필드(value 경로) 누락"""
        result = json.dumps({"name": "test"})  # id 없음
        entry = extractor.extract("mcp__trello__add_card_to_list", result, is_error=False)
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
