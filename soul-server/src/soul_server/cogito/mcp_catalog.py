"""Catalog management MCP tools.

폴더 CRUD, 세션 이동, 시스템 프롬프트, 세션 삭제.
모든 도구가 get_catalog_service() 단일 의존.
"""

from __future__ import annotations

from soul_server.cogito.mcp_tools import cogito_mcp
from soul_server.service.catalog_service import get_catalog_service


# ---------------------------------------------------------------------------
# MCP Tools
# ---------------------------------------------------------------------------

@cogito_mcp.tool()
async def list_folders() -> dict:
    """전체 폴더 목록을 조회한다.

    Returns:
        {folders: [{id: str, name: str, sortOrder: int}, ...]}
    """
    try:
        catalog_svc = get_catalog_service()
    except RuntimeError as e:
        return {"error": str(e)}
    folders = await catalog_svc.list_folders()
    return {"folders": folders}


@cogito_mcp.tool()
async def list_child_folders(folder_id: str | None = None) -> dict:
    """특정 폴더의 직접 자식 폴더만 조회한다."""
    try:
        catalog_svc = get_catalog_service()
    except RuntimeError as e:
        return {"error": str(e)}
    folders = await catalog_svc.list_child_folders(folder_id)
    return {"folder_id": folder_id, "folders": folders}


@cogito_mcp.tool()
async def create_folder(
    name: str,
    sort_order: int = 0,
    parent_folder_id: str | None = None,
) -> dict:
    """폴더를 생성한다.

    Args:
        name: 폴더 이름.
        sort_order: 정렬 순서 (기본 0).

    Returns:
        {id: str, name: str, sortOrder: int}
    """
    try:
        catalog_svc = get_catalog_service()
    except RuntimeError as e:
        return {"error": str(e)}
    return await catalog_svc.create_folder(
        name,
        sort_order,
        parent_folder_id=parent_folder_id,
    )


@cogito_mcp.tool()
async def rename_folder(folder_id: str, name: str) -> dict:
    """폴더 이름을 변경한다.

    Args:
        folder_id: 폴더 ID.
        name: 새 이름.

    Returns:
        {ok: true}
    """
    try:
        catalog_svc = get_catalog_service()
    except RuntimeError as e:
        return {"error": str(e)}
    await catalog_svc.rename_folder(folder_id, name)
    return {"ok": True}


@cogito_mcp.tool()
async def delete_folder(folder_id: str) -> dict:
    """폴더를 삭제한다.

    Args:
        folder_id: 폴더 ID.

    Returns:
        {ok: true}
    """
    try:
        catalog_svc = get_catalog_service()
    except RuntimeError as e:
        return {"error": str(e)}
    await catalog_svc.delete_folder(folder_id)
    return {"ok": True}


@cogito_mcp.tool()
async def move_sessions_to_folder(
    session_ids: list[str],
    folder_id: str | None = None,
) -> dict:
    """세션들을 지정한 폴더로 이동한다.

    Args:
        session_ids: 이동할 세션 ID 리스트.
        folder_id: 대상 폴더 ID. None이면 폴더 해제.

    Returns:
        {ok: true, moved: int}
    """
    try:
        catalog_svc = get_catalog_service()
    except RuntimeError as e:
        return {"error": str(e)}
    await catalog_svc.move_sessions_to_folder(session_ids, folder_id)
    return {"ok": True, "moved": len(session_ids)}


@cogito_mcp.tool()
async def get_folder_system_prompt(folder_id: str) -> dict:
    """폴더의 시스템 프롬프트(folderPrompt)를 조회한다.

    Args:
        folder_id: 조회할 폴더 ID.

    Returns:
        {folder_id: str, system_prompt: str | null}
    """
    try:
        catalog_svc = get_catalog_service()
    except RuntimeError as e:
        return {"error": str(e)}
    try:
        prompt = await catalog_svc.get_folder_system_prompt(folder_id)
    except ValueError as e:
        return {"error": str(e)}
    return {"folder_id": folder_id, "system_prompt": prompt}


@cogito_mcp.tool()
async def set_folder_system_prompt(
    folder_id: str,
    system_prompt: str | None = None,
) -> dict:
    """폴더의 시스템 프롬프트(folderPrompt)를 설정하거나 삭제한다.

    Args:
        folder_id: 대상 폴더 ID.
        system_prompt: 설정할 프롬프트. 빈 문자열 또는 null이면 삭제.

    Returns:
        {ok: true}
    """
    try:
        catalog_svc = get_catalog_service()
    except RuntimeError as e:
        return {"error": str(e)}
    try:
        await catalog_svc.set_folder_system_prompt(folder_id, system_prompt)
    except ValueError as e:
        return {"error": str(e)}
    return {"ok": True}


@cogito_mcp.tool()
async def delete_session(session_id: str) -> dict:
    """세션을 삭제한다.

    세션의 모든 이벤트 데이터도 함께 삭제된다.

    Args:
        session_id: 삭제할 세션 ID.

    Returns:
        {ok: true, session_id: str}
    """
    try:
        catalog_svc = get_catalog_service()
    except RuntimeError as e:
        return {"error": str(e)}
    await catalog_svc.delete_session(session_id)
    return {"ok": True, "session_id": session_id}
