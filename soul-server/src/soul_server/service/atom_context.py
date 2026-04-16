"""atom 컨텍스트 취득

atom API에서 subtree를 compile하여 Claude Code 세션에 주입할
컨텍스트 마크다운을 생성하는 독립 함수들.
"""

import logging
import re

import httpx

from soul_server.config import get_settings

logger = logging.getLogger(__name__)

_ATOM_ID_PATTERN = re.compile(
    r"<!-- node:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) .*?chars:(\d+).*?-->"
)
_ATOM_CONTEXT_HEADER = (
    "# atom 트리 | 드릴다운: "
    "mcp__atom__list_children(parent_node_id) · "
    "compile_subtree(node_id)\n"
)


def format_atom_context(markdown: str) -> str:
    """include_ids 출력의 HTML 주석을 [node_id] (N chars) 포맷으로 변환한다.

    입력 예시 (일반 노드):
        soulstream <!-- node:d71af4b5-c53a-49a4-9e07-9b6ee531fb56 card:... chars:123 -->
    입력 예시 (symlink 노드, chars 뒤에 symlink:true 필드 있음):
        ~ 심링크 <!-- node:a1b2c3d4-0000-0000-0000-000000000000 card:... chars:0 symlink:true -->
    출력 예시:
        soulstream [d71af4b5-c53a-49a4-9e07-9b6ee531fb56] (123 chars)
    """
    lines = []
    for line in markdown.splitlines():
        m = _ATOM_ID_PATTERN.search(line)
        if m:
            node_id = m.group(1)
            chars = m.group(2)
            line = _ATOM_ID_PATTERN.sub(f"[{node_id}] ({chars} chars)", line)
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
