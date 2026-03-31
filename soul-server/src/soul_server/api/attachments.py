"""
Attachments API - 첨부 파일 관리 엔드포인트
"""

import logging
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Form

from soul_server.models import (
    AttachmentUploadResponse,
    AttachmentCleanupResponse,
    ErrorResponse,
)
from soul_server.service import file_manager, AttachmentError
from soul_server.api.auth import verify_token

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post(
    "",
    response_model=AttachmentUploadResponse,
    status_code=201,
    responses={400: {"model": ErrorResponse}},
)
async def upload_attachment(
    file: UploadFile = File(...),
    thread_id: int = Form(...),
    _: str = Depends(verify_token),
):
    """
    첨부 파일 업로드
    """
    try:
        # 파일 내용 읽기
        content = await file.read()

        # 파일 저장
        result = await file_manager.save_file(
            thread_id=thread_id,
            filename=file.filename or "unnamed",
            content=content,
        )

        return AttachmentUploadResponse(
            path=result["path"],
            filename=result["filename"],
            size=result["size"],
            content_type=result["content_type"],
        )

    except AttachmentError as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "INVALID_REQUEST",
                    "message": str(e),
                    "details": {},
                }
            },
        )

    except Exception as e:
        logger.exception(f"Attachment upload error: {e}")
        raise HTTPException(
            status_code=500,
            detail={
                "error": {
                    "code": "INTERNAL_ERROR",
                    "message": f"파일 업로드 실패: {str(e)}",
                    "details": {},
                }
            },
        )


# ── 세션 기반 엔드포인트 (인증 불필요 — soulstream-server 내부 프록시 호환) ──
# 주의: /{thread_id} 패턴보다 먼저 등록해야 /sessions/... 가 올바르게 라우팅된다.

@router.post(
    "/sessions",
    response_model=AttachmentUploadResponse,
    status_code=201,
    responses={400: {"model": ErrorResponse}},
)
async def upload_session_attachment(
    file: UploadFile = File(...),
    session_id: str = Form(...),
):
    """
    세션 생성 전 파일 업로드 (session_id 기반).

    soul-dashboard가 세션 시작 전에 미리 파일을 업로드할 때 사용한다.
    soulstream-server 내부 프록시가 인증 없이 접근하므로 verify_token을 포함하지 않는다.
    """
    try:
        content = await file.read()
        result = await file_manager.save_file_for_session(
            filename=file.filename or "unnamed",
            content=content,
            session_id=session_id,
        )
        return AttachmentUploadResponse(
            path=result["path"],
            filename=result["filename"],
            size=result["size"],
            content_type=result["content_type"],
        )
    except AttachmentError as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "INVALID_REQUEST",
                    "message": str(e),
                    "details": {},
                }
            },
        )
    except Exception as e:
        logger.exception(f"Session attachment upload error: {e}")
        raise HTTPException(
            status_code=500,
            detail={
                "error": {
                    "code": "INTERNAL_ERROR",
                    "message": f"파일 업로드 실패: {str(e)}",
                    "details": {},
                }
            },
        )


@router.delete(
    "/sessions/{session_id}",
    response_model=AttachmentCleanupResponse,
)
async def cleanup_session_attachments(
    session_id: str,
):
    """
    세션 첨부 파일 정리.

    세션 생성 실패 또는 업로드 취소 시 서버 측 파일을 정리한다.
    soulstream-server 내부 프록시가 인증 없이 접근하므로 verify_token을 포함하지 않는다.
    """
    files_removed = file_manager.cleanup_session(session_id)
    return AttachmentCleanupResponse(cleaned=True, files_removed=files_removed)


@router.delete(
    "/{thread_id}",
    response_model=AttachmentCleanupResponse,
)
async def cleanup_attachments(
    thread_id: int,
    _: str = Depends(verify_token),
):
    """
    스레드의 첨부 파일 정리
    """
    files_removed = file_manager.cleanup_thread(thread_id)

    return AttachmentCleanupResponse(
        cleaned=True,
        files_removed=files_removed,
    )
