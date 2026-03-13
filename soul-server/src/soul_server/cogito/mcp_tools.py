"""Cogito MCP tools for soulstream.

Exposes cogito reflection data as MCP tools, allowing Claude Code sessions
to query service metadata at various levels of detail.

Dependencies are injected via :func:`init` at server startup; tools return
error dicts gracefully when cogito is not configured.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx
from fastapi import APIRouter, HTTPException
from fastmcp import FastMCP

from cogito.manifest import load_manifest

if TYPE_CHECKING:
    from soul_server.cogito.brief_composer import BriefComposer

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# FastMCP server instance (tools registered below)
# ---------------------------------------------------------------------------

cogito_mcp = FastMCP("soulstream-cogito")

# ---------------------------------------------------------------------------
# Runtime state — set by init() from main.py lifespan
# ---------------------------------------------------------------------------

_brief_composer: BriefComposer | None = None
_manifest_path: str | None = None


def init(brief_composer: BriefComposer, manifest_path: str) -> None:
    """Inject runtime dependencies from the app lifespan.

    Args:
        brief_composer: :class:`BriefComposer` instance.
        manifest_path: Absolute path to ``cogito-manifest.yaml``.
    """
    global _brief_composer, _manifest_path
    if _brief_composer is not None:
        logger.warning("cogito mcp_tools.init() called more than once; overwriting previous state")
    _brief_composer = brief_composer
    _manifest_path = manifest_path


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _load_manifest() -> dict[str, Any]:
    if not _manifest_path:
        raise RuntimeError("Cogito not configured: COGITO_MANIFEST_PATH not set")
    return load_manifest(_manifest_path)


def _find_service(manifest: dict[str, Any], name: str) -> dict[str, Any] | None:
    for svc in manifest.get("services", []):
        if svc.get("name") == name:
            return svc
    return None


async def _http_get(url: str, timeout: float = 5.0) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return resp.json()


async def _do_refresh() -> tuple[bool, str]:
    """Shared logic for brief refresh.

    Returns:
        ``(True, path_str)`` on success, ``(False, error_message)`` on failure.
    """
    if not _brief_composer:
        return False, "BriefComposer not initialized"
    path = await _brief_composer.write_brief()
    return True, str(path)


# ---------------------------------------------------------------------------
# MCP Tools
# ---------------------------------------------------------------------------

@cogito_mcp.tool()
async def reflect_service(
    service: str,
    level: int = 0,
    capability: str | None = None,
) -> dict:
    """서비스의 리플렉션 데이터를 조회한다.

    Args:
        service: 서비스 이름 (mcp-seosoyoung, supervisor, soulstream-server 등)
        level: 조회 깊이 (0=기능목록, 1=설정, 2=소스위치, 3=런타임상태)
        capability: 특정 capability만 조회 (선택)

    Returns:
        Level 0: {"identity": {...}, "capabilities": [...]}
        Level 1: {"configs": [...]}
        Level 2: {"sources": [...]}
        Level 3: {"status": "healthy", "pid": ..., "uptime_seconds": ...}
    """
    try:
        manifest = _load_manifest()
    except Exception as e:
        return {"error": str(e)}

    svc = _find_service(manifest, service)
    if not svc:
        available = [s.get("name") for s in manifest.get("services", [])]
        return {"error": f"서비스를 찾을 수 없습니다: {service}", "available": available}

    svc_type = svc.get("type", "internal")

    # External services only support Level 0 (static data)
    if svc_type == "external":
        if level > 0:
            return {"error": f"외부 서비스 {service}는 Level 0만 지원합니다"}
        return svc.get("static", {})

    endpoint = svc.get("endpoint", "")
    if not endpoint:
        return {"error": f"서비스 {service}에 endpoint가 설정되지 않았습니다"}

    # Build URL based on level
    url = endpoint
    if level == 1:
        url += "/config"
        if capability:
            url += f"/{capability}"
    elif level == 2:
        url += "/source"
        if capability:
            url += f"/{capability}"
    elif level == 3:
        url += "/runtime"

    try:
        return await _http_get(url)
    except Exception as e:
        return {"error": f"서비스 {service} 조회 실패: {e}"}


@cogito_mcp.tool()
async def reflect_brief() -> dict:
    """전체 서비스의 Level 0 브리프를 반환한다.

    Returns:
        {"services": [{"name": ..., "type": ..., "data": {...}}, ...]}
    """
    if not _brief_composer:
        return {"error": "BriefComposer가 초기화되지 않았습니다"}

    try:
        services = await _brief_composer.compose()
        result = []
        for name, svc_type, data in services:
            result.append({"name": name, "type": svc_type, "data": data})
        return {"services": result}
    except Exception as e:
        return {"error": f"브리프 조회 실패: {e}"}


@cogito_mcp.tool()
async def reflect_refresh() -> dict:
    """브리프 파일(brief.yaml)을 즉시 갱신한다.

    Returns:
        {"refreshed": true, "path": "...brief.yaml"}
    """
    try:
        ok, result = await _do_refresh()
    except Exception as e:
        return {"error": f"브리프 갱신 실패: {e}"}

    if not ok:
        return {"error": result}
    return {"refreshed": True, "path": result}


# ---------------------------------------------------------------------------
# REST API router — cogito-related endpoints outside of MCP
# ---------------------------------------------------------------------------

cogito_api_router = APIRouter(prefix="/cogito", tags=["cogito"])


@cogito_api_router.post("/refresh")
async def api_refresh() -> dict:
    """브리프를 즉시 갱신하는 REST 엔드포인트 (CLI에서 사용)."""
    try:
        ok, result = await _do_refresh()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Refresh failed: {e}")

    if not ok:
        raise HTTPException(status_code=503, detail=result)
    return {"refreshed": True, "path": result}
