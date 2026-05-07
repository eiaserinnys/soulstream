"""atom 컨텍스트 취득

atom API에서 subtree를 compile하여 Claude Code 세션에 주입할
컨텍스트 마크다운을 생성하는 독립 함수들.
"""

import logging
import re

import httpx

from soul_server.config import get_settings

logger = logging.getLogger(__name__)

_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

# atom HTML metadata 주석을 매칭한다 (PR #10 / 67323e8 형식 정합).
#   group(1) node_id  — 필수
#   group(2) card_id  — 옵션 (구 단일 ID 입력 폴백)
#   group(3) chars    — 옵션 (heading 모드는 chars 없음)
_ATOM_HTML_PATTERN = re.compile(
    rf"<!--\s*node:({_UUID})(?:\s+card:({_UUID}))?(?:\s+[^>]*?chars:(\d+))?[^>]*?-->"
)
_ATOM_CONTEXT_HEADER = (
    "# atom 트리 | 드릴다운: "
    "mcp__atom__list_children(parent_node_id) · "
    "compile_subtree(node_id)\n"
)


def _format_id_comment(m: re.Match) -> str:
    """매칭된 HTML 주석을 짧은 ID 라벨로 치환한다."""
    node_id = m.group(1)
    card_id = m.group(2)
    chars = m.group(3)
    label = f"[node:{node_id} card:{card_id}]" if card_id else f"[{node_id}]"
    if chars is not None:
        return f"{label} ({chars} chars)"
    return label


def format_atom_context(markdown: str) -> str:
    """atom HTML metadata 주석을 짧은 ID 라벨로 변환한다.

    출력 라벨 형식 (atom PR #10 정합):
      - 두 ID 보존:  ``[node:X card:Y] [(N chars)]``
      - 구 단일 ID:  ``[X] [(N chars)]``

    HTML 주석 없는 라인(짧은 라벨, ``*(cycle)*``, plain text)은
    정규식 미매칭으로 자동 통과한다 — 후처리 idempotent.

    입력 예시 (titles_only, 두 ID + chars):
        ``├── 시스템 <!-- node:UUIDX card:UUIDY depth:1 chars:42 -->``
    입력 예시 (heading 모드, chars 없음):
        ``## 시스템 <!-- node:UUIDX card:UUIDY depth:1 created:2026-04-01 -->``
    입력 예시 (symlink, chars 뒤 symlink:true):
        ``~ 심링크 <!-- node:UUIDX card:UUIDY depth:2 chars:0 symlink:true -->``
    출력 예시:
        ``├── 시스템 [node:UUIDX card:UUIDY] (42 chars)``
        ``## 시스템 [node:UUIDX card:UUIDY]``
        ``~ 심링크 [node:UUIDX card:UUIDY] (0 chars)``
    """
    lines = []
    for line in markdown.splitlines():
        line = _ATOM_HTML_PATTERN.sub(_format_id_comment, line)
        lines.append(line)
    return _ATOM_CONTEXT_HEADER + "\n".join(lines)


async def fetch_atom_context(node_id: str, depth: int, titles_only: bool) -> str | None:
    """atom API에서 subtree를 compile하여 마크다운 텍스트를 반환한다.
    실패 시 None 반환 (fallback)."""
    settings = get_settings()
    if not settings.atom_enabled or not settings.atom_server_url:
        return None
    url = f"{settings.atom_server_url.rstrip('/')}/api/tree/{node_id}/compile"
    params: dict[str, str | int] = {"depth": depth, "max_chars": 50000}
    params["include_ids"] = "true"  # titles_only와 무관하게 항상 포함
    if titles_only:
        params["titles_only"] = "true"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                url,
                params=params,
                headers={"x-api-key": settings.atom_api_key},
            )
        if resp.status_code == 200:
            data = resp.json()
            markdown = data.get("markdown") or None
            if markdown:
                markdown = format_atom_context(markdown)
            return markdown
        logger.warning("[atom] compile failed: status=%s node_id=%s", resp.status_code, node_id)
        return None
    except Exception as exc:  # noqa: BLE001
        logger.warning("[atom] compile error: %s node_id=%s", exc, node_id)
        return None
