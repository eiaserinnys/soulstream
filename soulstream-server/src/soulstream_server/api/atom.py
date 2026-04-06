"""
Atom 연동 API — /api/catalog/atom

atom 트리 노드 조회를 프록시한다.
폴더 설정 다이얼로그의 드롭다운에서 사용.
"""

import logging

import httpx
from fastapi import APIRouter, HTTPException

from soulstream_server.config import get_settings

logger = logging.getLogger(__name__)


def create_atom_router() -> APIRouter:
    router = APIRouter(prefix="/api/catalog/atom", tags=["atom"])

    @router.get("/nodes/{node_id}/children")
    async def list_atom_node_children(node_id: str) -> dict:
        """atom 트리 노드의 자식 목록 조회 (폴더 설정 UI 드롭다운용)."""
        s = get_settings()
        if not s.atom_enabled or not s.atom_server_url:
            raise HTTPException(status_code=503, detail="atom integration not enabled")
        url = f"{s.atom_server_url.rstrip('/')}/api/tree/{node_id}/children"
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(url, headers={"x-api-key": s.atom_api_key})
            if resp.status_code == 404:
                raise HTTPException(status_code=404, detail="Node not found")
            resp.raise_for_status()
            return {"children": resp.json()}
        except HTTPException:
            raise
        except Exception as exc:
            logger.warning("[atom proxy] error: %s", exc)
            raise HTTPException(status_code=502, detail="atom API unavailable") from exc

    return router
