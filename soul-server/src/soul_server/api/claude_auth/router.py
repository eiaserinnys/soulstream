"""
Claude Code OAuth 인증 API 라우터

엔드포인트 (session_manager 제공 시):
- POST /auth/claude/start - CLI 기반 인증 세션 시작
- POST /auth/claude/code - 인증 코드 제출
- DELETE /auth/claude/cancel - 세션 취소

공통 엔드포인트:
- POST /auth/claude/token - 토큰 직접 설정
- GET /auth/claude/token - 토큰 존재 여부 확인
- DELETE /auth/claude/token - 토큰 삭제
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from soul_server.api.auth import verify_token

from . import cli_runner
from .session import AuthSessionManager, SessionStatus
from .token_store import (
    delete_oauth_token,
    get_oauth_token,
    save_oauth_token,
    get_env_path,
    is_valid_token,
    load_profiles,
    get_current_profile_name,
    get_profiles_path,
)

logger = logging.getLogger(__name__)


# === Request/Response Models ===


class StartResponse(BaseModel):
    """POST /start 응답"""

    session_id: str
    auth_url: str
    status: str


class CodeRequest(BaseModel):
    """POST /code 요청"""

    session_id: str
    code: str


class CodeResponse(BaseModel):
    """POST /code 응답"""

    success: bool
    message: str


class CancelResponse(BaseModel):
    """DELETE /cancel 응답"""

    cancelled: bool
    session_id: str | None = None


class SetTokenRequest(BaseModel):
    """POST /token 요청 (직접 설정)"""

    token: str


class TokenResponse(BaseModel):
    """토큰 API 응답"""

    success: bool
    message: Optional[str] = None
    error: Optional[str] = None


class TokenStatusResponse(BaseModel):
    """토큰 상태 응답"""

    has_token: bool


class TokenDeleteResponse(BaseModel):
    """DELETE /token 응답"""

    deleted: bool


class ErrorResponse(BaseModel):
    """오류 응답"""

    error: str
    details: dict[str, Any] | None = None


class ProfilesResponse(BaseModel):
    """GET /profiles 응답"""

    node_id: str
    profiles: list[str]
    current_profile: Optional[str] = None


class ActivateProfileRequest(BaseModel):
    """POST /profiles/activate 요청"""

    profile: str


# === Router Factory ===


def create_claude_auth_router(
    session_manager: AuthSessionManager | None = None,
    env_path: Path | None = None,
) -> APIRouter:
    """
    Claude Auth API 라우터 팩토리

    Args:
        session_manager: 인증 세션 관리자
        env_path: .env 파일 경로 (None이면 기본 경로 사용)

    Returns:
        FastAPI APIRouter
    """
    router = APIRouter()

    def _get_env_path() -> Path:
        """env_path가 None이면 기본 경로 사용"""
        return env_path if env_path is not None else get_env_path()

    # === CLI 기반 인증 엔드포인트 (session_manager 필요) ===

    if session_manager is not None:
        @router.post("/start", response_model=StartResponse)
        async def start_auth(_: str = Depends(verify_token)):
            """
            POST /auth/claude/start - 인증 세션 시작

            subprocess로 `claude setup-token`을 실행하고
            OAuth URL을 반환합니다.

            기존 활성 세션이 있으면 자동으로 취소됩니다.
            """
            # 세션 생성
            session = await session_manager.create_session()

            try:
                # CLI 시작
                result = await cli_runner.start_cli()

                # 세션 업데이트
                session_manager.set_process(session, result.process)
                session_manager.update_status(
                    session,
                    status=SessionStatus.WAITING_CODE,
                    auth_url=result.auth_url,
                )

                return StartResponse(
                    session_id=session.id,
                    auth_url=result.auth_url,
                    status=session.status.value,
                )

            except cli_runner.CliRunnerError as e:
                logger.error(f"CLI start failed: {e}")
                session_manager.update_status(
                    session,
                    status=SessionStatus.FAILED,
                    error=str(e),
                )
                raise HTTPException(
                    status_code=500,
                    detail={"error": "CLI 시작 실패", "details": str(e)},
                )

        @router.post("/code", response_model=CodeResponse)
        async def submit_code(request: CodeRequest, _: str = Depends(verify_token)):
            """
            POST /auth/claude/code - 인증 코드 제출

            사용자가 입력한 인증 코드를 CLI에 전달하고
            토큰을 추출하여 저장합니다.
            """
            session = session_manager.get_session(request.session_id)
            if session is None:
                raise HTTPException(
                    status_code=404,
                    detail="세션을 찾을 수 없습니다",
                )

            if session.status != SessionStatus.WAITING_CODE:
                raise HTTPException(
                    status_code=400,
                    detail=f"세션 상태가 올바르지 않습니다: {session.status.value}",
                )

            if session._process is None:
                raise HTTPException(
                    status_code=500,
                    detail="CLI 프로세스가 없습니다",
                )

            # 상태 업데이트
            session_manager.update_status(session, status=SessionStatus.SUBMITTING)

            try:
                # 코드 제출 및 토큰 추출
                result = await cli_runner.submit_code(session._process, request.code)

                # 토큰 저장
                save_oauth_token(result.token, _get_env_path())

                # 세션 완료
                session_manager.update_status(session, status=SessionStatus.COMPLETED)

                return CodeResponse(
                    success=True,
                    message="인증 완료 (1년 유효)",
                )

            except cli_runner.CliRunnerError as e:
                logger.error(f"Code submit failed: {e}")
                session_manager.update_status(
                    session,
                    status=SessionStatus.FAILED,
                    error=str(e),
                )
                raise HTTPException(
                    status_code=400,
                    detail={"error": "코드 제출 실패", "details": str(e)},
                )

        @router.delete("/cancel", response_model=CancelResponse)
        async def cancel_session(_: str = Depends(verify_token)):
            """
            DELETE /auth/claude/cancel - 진행 중인 세션 취소

            현재 활성 세션이 있으면 취소하고 subprocess를 종료합니다.
            """
            current = session_manager.current_session
            if current is None or not current.is_active():
                return CancelResponse(cancelled=False, session_id=None)

            session_id = current.id
            cancelled = await session_manager.cancel_session(session_id)

            return CancelResponse(
                cancelled=cancelled,
                session_id=session_id if cancelled else None,
            )

    # === 직접 토큰 설정 엔드포인트 (항상 활성화) ===

    @router.post("/token", response_model=TokenResponse)
    async def set_token(
        request: SetTokenRequest, _: str = Depends(verify_token)
    ) -> TokenResponse:
        """OAuth 토큰 직접 설정

        토큰을 받아서 환경변수와 .env 파일에 저장합니다.
        다음 Claude Code spawn 시 바로 사용됩니다.
        """
        if not is_valid_token(request.token):
            logger.warning("Invalid token format received")
            return TokenResponse(success=False, error="유효하지 않은 토큰 형식입니다.")

        try:
            save_oauth_token(request.token, _get_env_path())
            logger.info("OAuth token saved successfully")
            return TokenResponse(success=True, message="토큰이 설정되었습니다.")
        except Exception as e:
            logger.exception(f"Failed to save OAuth token: {e}")
            return TokenResponse(success=False, error=f"토큰 저장 실패: {str(e)}")

    @router.get("/token", response_model=TokenStatusResponse)
    async def get_token_status(_: str = Depends(verify_token)):
        """
        GET /auth/claude/token - 토큰 존재 여부 확인
        """
        token = get_oauth_token()
        return TokenStatusResponse(has_token=token is not None)

    @router.delete("/token", response_model=TokenResponse)
    async def delete_token(_: str = Depends(verify_token)) -> TokenResponse:
        """OAuth 토큰 삭제

        환경변수와 .env 파일에서 토큰을 삭제합니다.
        """
        try:
            had_token = delete_oauth_token(_get_env_path())
            if had_token:
                logger.info("OAuth token deleted successfully")
                return TokenResponse(success=True, message="토큰이 삭제되었습니다.")
            else:
                logger.info("No OAuth token to delete")
                return TokenResponse(success=True, message="삭제할 토큰이 없습니다.")
        except Exception as e:
            logger.exception(f"Failed to delete OAuth token: {e}")
            return TokenResponse(success=False, error=f"토큰 삭제 실패: {str(e)}")

    @router.get("/profiles", response_model=ProfilesResponse)
    async def get_profiles(_: str = Depends(verify_token)):
        """OAuth 프로필 목록 조회

        oauth_token.yaml에서 프로필을 읽어 반환합니다.
        current_profile은 현재 CLAUDE_CODE_OAUTH_TOKEN과 일치하는 프로필명입니다.
        """
        profiles = load_profiles(get_profiles_path())
        current = get_current_profile_name(profiles)
        node_id = os.environ["SOULSTREAM_NODE_ID"]
        return ProfilesResponse(
            node_id=node_id,
            profiles=list(profiles.keys()),
            current_profile=current,
        )

    @router.post("/profiles/activate", response_model=TokenResponse)
    async def activate_profile(
        request: ActivateProfileRequest, _: str = Depends(verify_token)
    ) -> TokenResponse:
        """OAuth 프로필 활성화

        지정된 프로필의 토큰을 os.environ과 .env 파일에 저장합니다.
        다음 Claude Code spawn 시 즉시 반영됩니다.
        """
        profiles = load_profiles(get_profiles_path())
        if request.profile not in profiles:
            return TokenResponse(
                success=False,
                error=f"프로필 '{request.profile}'이(가) 없습니다. oauth_token.yaml을 확인해주세요.",
            )
        token = profiles[request.profile]
        if not is_valid_token(token):
            return TokenResponse(
                success=False,
                error=f"프로필 '{request.profile}'의 토큰 형식이 유효하지 않습니다. oauth_token.yaml을 확인해주세요.",
            )
        try:
            save_oauth_token(token, _get_env_path())
            logger.info(f"OAuth 프로필 전환: '{request.profile}'")
            return TokenResponse(
                success=True,
                message=f"프로필 '{request.profile}'(으)로 전환했습니다.",
            )
        except Exception as e:
            logger.exception(f"프로필 활성화 실패: {e}")
            return TokenResponse(success=False, error=f"프로필 활성화 실패: {str(e)}")

    return router
