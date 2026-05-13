"""Attachments API 라우터 — /api/attachments

orch ↔ 노드 cross-node 첨부 통신은 WS reverse-proxy로 통합되어 있다.
노드 self-reported host:port HTTP 가정은 폐기되었다 — NAT/proxy 토폴로지나
노드가 자기 외부 도달 가능 IP를 모르는 환경(`settings.host="0.0.0.0"` 등)에서
orch가 그 주소로 접근 불가했던 결함(2026-05-13 운영 로그: eias-shopping
host=127.0.0.1) 회로 차단. 노드 등록 시 신뢰 가능하게 outbound로 연결된
단일 WS wire가 정본이다 (design-principles §3·§5·§9). atom 작업 이력 260513.01.

본 라우트는 multipart binary를 받아 base64-in-JSON으로 노드 WS에 forward하고,
응답(JSON path)을 그대로 클라이언트에 반환한다. 노드 측 검증 실패(파일 크기/
확장자)는 `INVALID_REQUEST:` prefix wire 약속으로 400 분류된다.
"""

import base64

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile

from soulstream_server.nodes.node_manager import NodeManager


def create_attachments_router(
    node_manager: NodeManager,
    dependencies: list | None = None,
) -> APIRouter:
    """attachments 라우터 팩토리.

    기존 api/sessions.py의 팩토리 클로저 패턴을 따른다. node_manager는
    FastAPI DI가 아니라 클로저로 주입받는다.
    """
    router = APIRouter(
        prefix="/api/attachments",
        tags=["attachments"],
        dependencies=dependencies or [],
    )

    @router.post("/sessions", status_code=201)
    async def proxy_upload(
        request: Request,
        file: UploadFile = File(...),
        session_id: str = Form(...),
        node_id: str = Query(..., alias="nodeId"),
    ):
        """WS reverse-proxy: 노드에 base64 binary로 attachment 업로드를 위임.

        - 미등록 노드 → 404
        - 노드가 INVALID_REQUEST: prefix EVT_ERROR → 400 (file 검증 실패)
        - 노드가 그 외 EVT_ERROR → 502
        - 노드 응답 timeout → 504
        """
        node = node_manager.get_node(node_id)
        if node is None:
            raise HTTPException(404, f"Node '{node_id}' not found")

        content = await file.read()
        content_b64 = base64.b64encode(content).decode("ascii")

        try:
            result = await node.send_upload_attachment(
                session_id=session_id,
                filename=file.filename or "unnamed",
                content_type=file.content_type or "application/octet-stream",
                content_b64=content_b64,
            )
        except TimeoutError as e:
            raise HTTPException(504, f"Node attachment upload timed out: {e}")
        except RuntimeError as e:
            # 노드 측 EVT_ERROR는 NodeConnection.handle_message가 RuntimeError로 raise한다.
            # INVALID_REQUEST: prefix는 file 검증 실패 — 클라이언트 잘못이므로 400.
            msg = str(e)
            if msg.startswith("INVALID_REQUEST:"):
                raise HTTPException(400, msg.removeprefix("INVALID_REQUEST:").strip())
            raise HTTPException(502, f"Node attachment upload failed: {msg}")

        return {
            "path": result["path"],
            "filename": result["filename"],
            "size": result["size"],
            "content_type": result["content_type"],
        }

    @router.delete("/sessions/{session_id}")
    async def proxy_delete(
        session_id: str,
        request: Request,
        node_id: str = Query(..., alias="nodeId"),
    ):
        """WS reverse-proxy: 노드에 세션 첨부 정리를 위임.

        분류는 upload와 동일.
        """
        node = node_manager.get_node(node_id)
        if node is None:
            raise HTTPException(404, f"Node '{node_id}' not found")

        try:
            result = await node.send_delete_session_attachments(session_id)
        except TimeoutError as e:
            raise HTTPException(504, f"Node attachment delete timed out: {e}")
        except RuntimeError as e:
            msg = str(e)
            if msg.startswith("INVALID_REQUEST:"):
                raise HTTPException(400, msg.removeprefix("INVALID_REQUEST:").strip())
            raise HTTPException(502, f"Node attachment delete failed: {msg}")

        return {
            "cleaned": result.get("cleaned", True),
            "files_removed": result.get("files_removed", 0),
        }

    return router
