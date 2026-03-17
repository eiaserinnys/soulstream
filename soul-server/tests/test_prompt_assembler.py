"""
test_prompt_assembler.py - assemble_prompt() 단위 테스트 및 ContextItem 스키마 검증
"""

import json
import pytest
from pydantic import ValidationError
from soul_server.models.schemas import ContextItem, StructuredContext
from soul_server.service.prompt_assembler import assemble_prompt


def _ctx(*items):
    """테스트용 context dict 생성 헬퍼."""
    return {"items": [{"key": k, "label": l, "content": c} for k, l, c in items]}


class TestAssemblePromptNoContext:
    def test_none_context_returns_prompt_as_is(self):
        result = assemble_prompt("질문입니다", None)
        assert result == "질문입니다"

    def test_empty_items_returns_prompt_as_is(self):
        ctx = {"items": []}
        result = assemble_prompt("질문입니다", ctx)
        assert result == "질문입니다"


class TestAssemblePromptContentTypes:
    def test_str_content_wrapped_in_xml_tag(self):
        ctx = _ctx(("history", "히스토리", "대화 내용"))
        result = assemble_prompt("질문입니다", ctx)
        assert result == "<history>\n대화 내용\n</history>\n\n질문입니다"

    def test_dict_content_json_serialized(self):
        ctx = _ctx(("data", "데이터", {"a": 1}))
        result = assemble_prompt("질문입니다", ctx)
        expected_json = json.dumps({"a": 1}, ensure_ascii=False)
        assert result == f"<data>\n{expected_json}\n</data>\n\n질문입니다"

    def test_list_content_json_serialized(self):
        ctx = _ctx(("msgs", "메시지", [{"user": "A", "text": "안녕"}]))
        result = assemble_prompt("질문입니다", ctx)
        expected_json = json.dumps([{"user": "A", "text": "안녕"}], ensure_ascii=False)
        assert result == f"<msgs>\n{expected_json}\n</msgs>\n\n질문입니다"

    def test_none_content_tag_omitted(self):
        ctx = _ctx(("skip", "건너뜀", None))
        result = assemble_prompt("질문입니다", ctx)
        assert result == "질문입니다"

    def test_int_content_converted_to_str(self):
        ctx = _ctx(("count", "카운트", 42))
        result = assemble_prompt("질문입니다", ctx)
        assert result == "<count>\n42\n</count>\n\n질문입니다"

    def test_bool_content_converted_to_str(self):
        ctx = _ctx(("flag", "플래그", True))
        result = assemble_prompt("질문입니다", ctx)
        assert result == "<flag>\nTrue\n</flag>\n\n질문입니다"


class TestAssemblePromptMultipleItems:
    def test_multiple_items_order_preserved(self):
        ctx = _ctx(
            ("first", "첫번째", "A"),
            ("second", "두번째", "B"),
            ("third", "세번째", "C"),
        )
        result = assemble_prompt("질문", ctx)
        assert result == "<first>\nA\n</first>\n<second>\nB\n</second>\n<third>\nC\n</third>\n\n질문"

    def test_none_content_items_skipped_in_multi(self):
        ctx = _ctx(
            ("keep", "유지", "유지됨"),
            ("skip", "건너뜀", None),
            ("also_keep", "유지2", "유지됨2"),
        )
        result = assemble_prompt("질문", ctx)
        assert result == "<keep>\n유지됨\n</keep>\n<also_keep>\n유지됨2\n</also_keep>\n\n질문"

    def test_all_none_content_returns_prompt_as_is(self):
        ctx = _ctx(("a", "a", None), ("b", "b", None))
        result = assemble_prompt("질문", ctx)
        assert result == "질문"


class TestContextItemKeyValidation:
    def test_valid_key_accepted(self):
        item = ContextItem(key="history", label="히스토리", content="내용")
        assert item.key == "history"

    def test_key_with_underscore_accepted(self):
        item = ContextItem(key="_private_key", label="라벨", content="내용")
        assert item.key == "_private_key"

    def test_key_with_hyphen_accepted(self):
        item = ContextItem(key="my-key", label="라벨", content="내용")
        assert item.key == "my-key"

    def test_key_starting_with_digit_rejected(self):
        with pytest.raises(ValidationError):
            ContextItem(key="1invalid", label="라벨", content="내용")

    def test_key_with_space_rejected(self):
        with pytest.raises(ValidationError):
            ContextItem(key="in valid", label="라벨", content="내용")

    def test_key_with_angle_bracket_rejected(self):
        with pytest.raises(ValidationError):
            ContextItem(key="a>b", label="라벨", content="내용")

    def test_key_with_newline_rejected(self):
        with pytest.raises(ValidationError):
            ContextItem(key="a\nb", label="라벨", content="내용")


class TestAssemblePromptBackwardCompat:
    def test_context_none_backward_compat(self):
        """context 없는 요청은 기존 동작과 완전히 동일하다."""
        original_prompt = "이것은 기존 방식으로 조립된 단일 문자열 프롬프트입니다."
        result = assemble_prompt(original_prompt, None)
        assert result == original_prompt


class TestAssemblePromptSecurity:
    def test_invalid_key_skipped(self):
        """유효하지 않은 key(XML 태그명 형식 위반)는 건너뛴다."""
        ctx = _ctx(("valid", "유효", "값"), ("in valid", "공백있음", "위험"))
        result = assemble_prompt("질문", ctx)
        assert "<valid>" in result
        assert "in valid" not in result

    def test_key_with_angle_brackets_skipped(self):
        """꺾쇠괄호가 포함된 key는 건너뛴다."""
        ctx = _ctx(("a>b", "위험", "내용"))
        result = assemble_prompt("질문", ctx)
        assert result == "질문"

    def test_closing_tag_in_str_content_escaped(self):
        """문자열 content 내부의 닫힘 태그 패턴이 이스케이프된다."""
        ctx = _ctx(("data", "데이터", "결과는 </data> 이후에 나옵니다"))
        result = assemble_prompt("질문", ctx)
        # 이스케이프된 패턴이 content 내에 존재해야 한다
        assert "<\\/" in result
        # 실제 닫힘 태그는 XML 구조 마감으로 1번만 등장해야 한다 (조기 종료 없음)
        assert result.count("</data>") == 1

    def test_empty_string_content_skipped(self):
        """빈 문자열 content는 None과 동일하게 태그를 생략한다."""
        ctx = _ctx(("key", "키", ""))
        result = assemble_prompt("질문", ctx)
        assert result == "질문"

    def test_empty_string_and_valid_items_mixed(self):
        """빈 문자열 항목은 건너뛰고 나머지는 정상 처리된다."""
        ctx = _ctx(("empty", "빈값", ""), ("valid", "유효", "값"))
        result = assemble_prompt("질문", ctx)
        assert "<valid>" in result
        assert "<empty>" not in result
