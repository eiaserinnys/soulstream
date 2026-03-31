"""
Attachments API 라우터 — /api/attachments

soul-server의 /attachments/sessions 엔드포인트로 파일 업로드/삭제를 프록시한다.
nodeId 쿼리 파라미터로 타겟 노드를 지정한다.
"""

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
import httpx

from soulstream_server.nodes.node_manager import NodeManager


def create_attachments_router(node_manager: NodeManager) -> APIRouter:
    """attachments 라우터 팩토리.

    기존 api/sessions.py의 팩토리 클로저 패턴을 따른다.
    node_manager는 FastAPI DI가 아니라 클로저로 주입받는다.
    """
    router = APIRouter(prefix="/api/attachments", tags=["attachments"])

    @router.post("/sessions", status_code=201)
    async def proxy_upload(
        file: UploadFile = File(...),
        session_id: str = Form(...),
        node_id: str = Query(..., alias="nodeId"),
    ):
        """파일 업로드를 지정된 노드의 soul-server로 프록시한다.

        nodeId가 등록되지 않은 노드를 가리키면 404를 반환한다.
        """
        node = node_manager.get_node(node_id)
        if node is None:
            raise HTTPException(404, f"Node '{node_id}' not found")

        soul_url = f"http://{node.host}:{node.port}/attachments/sessions"
        content = await file.read()

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                soul_url,
                data={"session_id": session_id},
                files={"file": (file.filename, content, file.content_type)},
                # 인증 헤더 불필요: soul-server의 /attachments/sessions 엔드포인트는
                # Phase 1에서 인증 없이 구현된다 (기존 /api/agents와 동일한 패턴).
            )
            response.raise_for_status()
        return response.json()

    @router.delete("/sessions/{session_id}")
    async def proxy_delete(
        session_id: str,
        node_id: str = Query(..., alias="nodeId"),
    ):
        """세션 첨부 파일 삭제를 지정된 노드의 soul-server로 프록시한다.

        nodeId가 등록되지 않은 노드를 가리키면 404를 반환한다.
        """
        node = node_manager.get_node(node_id)
        if node is None:
            raise HTTPException(404, f"Node '{node_id}' not found")

        soul_url = f"http://{node.host}:{node.port}/attachments/sessions/{session_id}"
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.delete(soul_url)
            response.raise_for_status()
        return response.json()

    return router
