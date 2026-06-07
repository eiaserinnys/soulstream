"""Attachments API 라우터 — /api/attachments

orch ↔ 노드 cross-node 첨부 통신은 WS reverse-proxy로 통합되어 있다.
노드 self-reported host:port HTTP 가정은 폐기되었다 — NAT/proxy 토폴로지나
노드가 자기 외부 도달 가능 IP를 모르는 환경(`settings.host="0.0.0.0"` 등)에서
orch가 그 주소로 접근 불가했던 결함(2026-05-13 운영 로그: eias-shopping
host=127.0.0.1) 회로 차단. 노드 등록 시 신뢰 가능하게 outbound로 연결된
단일 WS wire가 정본이다 (design-principles §3·§5·§9). atom 작업 이력 260513.01.

본 라우트는 multipart binary를 받아 노드 WS에 청크 명령 시퀀스로 forward하고,
구버전 노드에 대해서만 8MB 이하 legacy single-frame base64 wire로 fallback한다.
응답(JSON path)을 그대로 클라이언트에 반환한다. 노드 측 검증 실패(파일 크기/
확장자)는 `INVALID_REQUEST:` prefix wire 약속으로 400 분류된다.
"""

import base64
import io
import json
from pathlib import PurePath
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse

from soulstream_server.constants import (
    ATTACHMENT_UPLOAD_CHUNK_SIZE,
    LEGACY_ATTACHMENT_MAX_SIZE,
    MAX_ATTACHMENT_SIZE,
)
from soulstream_server.dashboard_access import access_for_request, require_session_allowed
from soulstream_server.nodes.node_manager import NodeManager


def _access_email_from_multipart_caller_info(caller_info: str | None) -> str | None:
    if caller_info is None:
        return None
    try:
        parsed = json.loads(caller_info)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(parsed, dict):
        return None
    email = parsed.get("email")
    return email if isinstance(email, str) else None


def create_attachments_router(
    node_manager: NodeManager,
    db: Any | None = None,
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
        caller_info: str | None = Form(None),
        node_id: str = Query(..., alias="nodeId"),
    ):
        """WS reverse-proxy: 노드에 chunked attachment 업로드를 위임.

        - 미등록 노드 → 404
        - 노드가 INVALID_REQUEST: prefix EVT_ERROR → 400 (file 검증 실패)
        - 노드가 그 외 EVT_ERROR → 502
        - 노드 응답 timeout → 504
        """
        node = node_manager.get_node(node_id)
        if node is None:
            raise HTTPException(404, f"Node '{node_id}' not found")
        access_email = _access_email_from_multipart_caller_info(caller_info)
        if db is not None and access_for_request(
            request,
            access_email=access_email,
        ).restricted:
            await require_session_allowed(
                request,
                db,
                session_id,
                access_email=access_email,
            )

        expected_size = getattr(file, "size", None)
        if expected_size is not None and expected_size > MAX_ATTACHMENT_SIZE:
            raise HTTPException(
                400,
                f"파일이 너무 큽니다 ({expected_size // 1024 // 1024}MB > "
                f"{MAX_ATTACHMENT_SIZE // 1024 // 1024}MB)",
            )

        try:
            result = await node.send_streamed_upload_attachment(
                session_id=session_id,
                filename=file.filename or "unnamed",
                content_type=file.content_type or "application/octet-stream",
                chunks=_iter_upload_chunks(file),
                expected_size=expected_size,
            )
        except ConnectionError as e:
            # 노드 disconnect/close 중에 outstanding 요청이 cancel된 케이스.
            # 503으로 분류하여 클라이언트가 retry할 수 있게 한다.
            raise HTTPException(503, f"Node temporarily unavailable: {e}")
        except TimeoutError as e:
            raise HTTPException(504, f"Node attachment upload timed out: {e}")
        except RuntimeError as e:
            # 노드 측 EVT_ERROR는 NodeConnection.handle_message가 RuntimeError로 raise한다.
            # INVALID_REQUEST: prefix는 file 검증 실패 — 클라이언트 잘못이므로 400.
            msg = str(e)
            if msg.startswith("INVALID_REQUEST:"):
                raise HTTPException(400, msg.removeprefix("INVALID_REQUEST:").strip())
            if _is_chunked_upload_unsupported(msg):
                try:
                    result = await _legacy_upload_if_allowed(
                        node=node,
                        file=file,
                        session_id=session_id,
                        expected_size=expected_size,
                    )
                except ConnectionError as legacy_error:
                    raise HTTPException(
                        503, f"Node temporarily unavailable: {legacy_error}"
                    )
                except TimeoutError as legacy_error:
                    raise HTTPException(
                        504, f"Node attachment upload timed out: {legacy_error}"
                    )
                except RuntimeError as legacy_error:
                    legacy_msg = str(legacy_error)
                    if legacy_msg.startswith("INVALID_REQUEST:"):
                        raise HTTPException(
                            400,
                            legacy_msg.removeprefix("INVALID_REQUEST:").strip(),
                        )
                    raise HTTPException(
                        502, f"Node attachment upload failed: {legacy_msg}"
                    )
            else:
                raise HTTPException(502, f"Node attachment upload failed: {msg}")

        # 노드 응답 키 검증 — code-review P1-1 (Phase 2). KeyError 누수 차단.
        if not isinstance(result, dict) or not all(
            isinstance(result.get(k), expected_type)
            for k, expected_type in [
                ("path", str), ("filename", str), ("size", int), ("content_type", str),
            ]
        ):
            raise HTTPException(502, "Node returned malformed upload response")
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
        if db is not None and access_for_request(request).restricted:
            await require_session_allowed(request, db, session_id)

        try:
            result = await node.send_delete_session_attachments(session_id)
        except ConnectionError as e:
            raise HTTPException(503, f"Node temporarily unavailable: {e}")
        except TimeoutError as e:
            raise HTTPException(504, f"Node attachment delete timed out: {e}")
        except RuntimeError as e:
            msg = str(e)
            if msg.startswith("INVALID_REQUEST:"):
                raise HTTPException(400, msg.removeprefix("INVALID_REQUEST:").strip())
            raise HTTPException(502, f"Node attachment delete failed: {msg}")

        # 노드 응답 검증 — code-review P1-1 (Phase 2). 비-dict 응답 차단.
        if not isinstance(result, dict):
            raise HTTPException(502, "Node returned malformed delete response")
        return {
            "cleaned": bool(result.get("cleaned", True)),
            "files_removed": int(result.get("files_removed", 0)),
        }

    @router.get("/files")
    async def proxy_download(
        request: Request,
        node_id: str = Query(..., alias="nodeId"),
        path: str = Query(...),
    ):
        """노드 디스크의 첨부 binary를 cross-node로 받아 streaming response로 forward.

        Phase 2 (atom 260513.02 — chat-inline-attachment): 채팅 영역 사용자
        발화 말풍선에 첨부 이미지를 인라인 표시하기 위한 다운로드 라우트.
        soul-app `UserMessage.tsx`가 `<Image source={{uri}} />`로 호출한다.

        Access control 결정: 기존 라우트와 동일하게 `dependencies=api_deps`
        (JWT 검증)만 적용. 세션 owner 검증은 *현 라우트 전체에 동시 적용*되어야
        정합이므로 본 카드 범위 외 후속 카드. INVALID_REQUEST/NOT_FOUND prefix
        wire 약속은 Phase 1과 동일.
        """
        node = node_manager.get_node(node_id)
        if node is None:
            raise HTTPException(404, f"Node '{node_id}' not found")
        if db is not None and access_for_request(request).restricted:
            await require_session_allowed(request, db, PurePath(path).parent.name)

        try:
            result = await node.send_download_attachment(path=path)
        except ConnectionError as e:
            raise HTTPException(503, f"Node temporarily unavailable: {e}")
        except TimeoutError as e:
            raise HTTPException(504, f"Node download timed out: {e}")
        except RuntimeError as e:
            msg = str(e)
            if msg.startswith("NOT_FOUND:"):
                raise HTTPException(404, msg.removeprefix("NOT_FOUND:").strip())
            if msg.startswith("INVALID_REQUEST:"):
                raise HTTPException(400, msg.removeprefix("INVALID_REQUEST:").strip())
            raise HTTPException(502, f"Node download failed: {msg}")

        # 노드 응답 키 검증 — 예상 외 malformed 응답을 KeyError로 누수시키지 않는다
        # (FastAPI 기본 500 대신 명시적 502 분류). code-review P1-1.
        content_b64 = result.get("content_b64") if isinstance(result, dict) else None
        filename = result.get("filename") if isinstance(result, dict) else None
        if not isinstance(content_b64, str) or not isinstance(filename, str):
            raise HTTPException(502, "Node returned malformed download response")
        try:
            content = base64.b64decode(content_b64, validate=True)
        except (ValueError, TypeError) as e:
            raise HTTPException(502, f"Node returned invalid base64: {e}")

        headers = {
            # `save_file_for_session`의 `{ms}_{filename}` ts-prefix 규약 덕분에 path가
            # 사실상 unique → immutable 가정 안전. file_manager의 save naming 규약을
            # 바꾸면 본 캐시 정책도 함께 재평가 필요 (정본 cross-link). 캐시 무효화가
            # 필요한 케이스는 후속 카드.
            "Content-Disposition": f'inline; filename="{filename}"',
            "Cache-Control": "private, max-age=3600",
        }
        return StreamingResponse(
            io.BytesIO(content),
            media_type=result.get("content_type") or "application/octet-stream",
            headers=headers,
        )

    return router


async def _iter_upload_chunks(file: UploadFile):
    while True:
        chunk = await file.read(ATTACHMENT_UPLOAD_CHUNK_SIZE)
        if not chunk:
            break
        yield chunk


def _is_chunked_upload_unsupported(message: str) -> bool:
    return (
        "upload_attachment_start" in message
        and ("Not implemented" in message or "Unknown command" in message)
    )


async def _legacy_upload_if_allowed(
    *,
    node,
    file: UploadFile,
    session_id: str,
    expected_size: int | None,
) -> dict:
    if expected_size is not None and expected_size > LEGACY_ATTACHMENT_MAX_SIZE:
        raise HTTPException(
            502,
            "Node does not support chunked attachment upload and file exceeds "
            f"legacy {LEGACY_ATTACHMENT_MAX_SIZE // 1024 // 1024}MB limit",
        )

    await file.seek(0)
    content = await _read_legacy_payload(file)
    content_b64 = base64.b64encode(content).decode("ascii")
    return await node.send_upload_attachment(
        session_id=session_id,
        filename=file.filename or "unnamed",
        content_type=file.content_type or "application/octet-stream",
        content_b64=content_b64,
    )


async def _read_legacy_payload(file: UploadFile) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(ATTACHMENT_UPLOAD_CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > LEGACY_ATTACHMENT_MAX_SIZE:
            raise HTTPException(
                502,
                "Node does not support chunked attachment upload and file exceeds "
                f"legacy {LEGACY_ATTACHMENT_MAX_SIZE // 1024 // 1024}MB limit",
            )
        chunks.append(chunk)
    return b"".join(chunks)
