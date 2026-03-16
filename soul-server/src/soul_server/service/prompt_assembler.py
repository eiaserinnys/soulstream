"""
Prompt Assembler - 구조화된 맥락을 프롬프트로 조립

StructuredContext의 각 항목을 XML 태그로 변환하여 prompt 앞에 배치합니다.
"""

import json
from typing import Optional


def assemble_prompt(prompt: str, context: Optional[dict]) -> str:
    """prompt와 context를 조합하여 최종 프롬프트를 생성한다.

    Args:
        prompt: 사용자 요청 문자열
        context: StructuredContext.model_dump() 결과 dict (None이면 prompt 그대로 반환)

    Returns:
        context 항목들이 XML 태그로 변환되어 prompt 앞에 배치된 최종 프롬프트.
        context가 None이거나 items가 비어 있으면 prompt를 그대로 반환.

    직렬화 규칙:
        - dict / list → json.dumps
        - str → 그대로
        - int / float / bool → str()
        - None → 해당 태그 생략
    """
    if not context:
        return prompt

    items = context.get("items") or []
    if not items:
        return prompt

    parts: list[str] = []
    for item in items:
        content = item.get("content")
        if content is None:
            continue
        key = item["key"]
        if isinstance(content, str):
            serialized = content
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
