"""
Prompt Assembler - 구조화된 맥락을 프롬프트로 조립

StructuredContext의 각 항목을 XML 태그로 변환하여 prompt 앞에 배치합니다.
"""

import json
import re
from typing import Optional

_TAG_NAME_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_\-]*$")


def _escape_closing_tag(text: str, key: str) -> str:
    """문자열 content 내부에서 닫힘 태그 패턴을 이스케이프한다.

    `</key>` 패턴이 content 안에 있으면 태그가 조기 종료되어
    프롬프트 구조가 파손된다. `</` 를 `<\\/` 로 치환하여 방어한다.
    """
    return text.replace("</", "<\\/")


def assemble_prompt(prompt: str, context: Optional[dict]) -> str:
    """prompt와 context를 조합하여 최종 프롬프트를 생성한다.

    Args:
        prompt: 사용자 요청 문자열
        context: StructuredContext.model_dump() 결과 dict (None이면 prompt 그대로 반환)

    Returns:
        context 항목들이 XML 태그로 변환되어 prompt 앞에 배치된 최종 프롬프트.
        context가 None이거나 items가 비어 있으면 prompt를 그대로 반환.

    직렬화 규칙:
        - dict / list → json.dumps (꺾쇠가 포함되지 않으므로 태그 파손 없음)
        - str → 그대로 삽입 (단, 닫힘 태그 패턴 이스케이프 적용)
        - int / float / bool → str()
        - None 또는 빈 문자열("") → 해당 태그 생략

    유효하지 않은 key(XML 태그명 형식 위반)는 해당 항목을 건너뛴다.
    """
    if not context:
        return prompt

    items = context.get("items") or []
    if not items:
        return prompt

    parts: list[str] = []
    for item in items:
        key = item.get("key", "")
        # key 검증: 유효하지 않은 태그명은 건너뜀
        if not _TAG_NAME_RE.fullmatch(key):
            continue
        content = item.get("content")
        if content is None or content == "":
            continue
        if isinstance(content, str):
            serialized = _escape_closing_tag(content, key)
        elif isinstance(content, (dict, list)):
            serialized = json.dumps(content, ensure_ascii=False)
        else:
            # int, float, bool 등
            serialized = str(content)
        parts.append(f"<{key}>\n{serialized}\n</{key}>")

    if not parts:
        return prompt

    context_block = "\n".join(parts)
    return f"{context_block}\n\n{prompt}"
