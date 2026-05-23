"""Provider OAuth usage proxy API.

The node owns local OAuth files and Claude token storage. The orchestrator only
proxies the request over the existing node WebSocket command channel.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from soulstream_server.nodes.node_manager import NodeManager

PROVIDERS = {"claude", "codex", "gemini"}


def create_provider_usage_router(
    node_manager: NodeManager,
    dependencies: list | None = None,
) -> APIRouter:
    router = APIRouter(
        prefix="/api",
        tags=["provider-usage"],
        dependencies=dependencies or [],
    )

    @router.get("/nodes/{node_id}/provider-usage")
    async def node_provider_usage(node_id: str):
        node_conn = node_manager.get_node(node_id)
        if node_conn is None:
            raise HTTPException(status_code=404, detail=f"Node {node_id} not connected")
        result = await node_conn.send_provider_usage_get()
        if not result.get("success"):
            raise HTTPException(status_code=400, detail=result.get("error", "unknown"))
        return result["data"]

    @router.get("/nodes/{node_id}/provider-usage/{provider}")
    async def node_provider_usage_one(node_id: str, provider: str):
        if provider not in PROVIDERS:
            raise HTTPException(
                status_code=400,
                detail="provider must be one of: claude, codex, gemini",
            )
        node_conn = node_manager.get_node(node_id)
        if node_conn is None:
            raise HTTPException(status_code=404, detail=f"Node {node_id} not connected")
        result = await node_conn.send_provider_usage_get(provider)
        if not result.get("success"):
            raise HTTPException(status_code=400, detail=result.get("error", "unknown"))
        return result["data"]

    return router
