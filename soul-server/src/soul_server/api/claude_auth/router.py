"""
Claude OAuth 토큰 설정 API

POST /auth/claude/token - 토큰 설정
DELETE /auth/claude/token - 토큰 삭제
"""

import logging
from typing import Optional
from pathlib import Path
from pydantic import BaseModel

from fastapi import APIRouter, Depends

from soul_server.api.auth import verify_token
from .token_store import is_valid_token, save_oauth_token, delete_oauth_token, get_env_path


logger = logging.getLogger(__name__)


class SetTokenRequest(BaseModel):
    """토큰 설정 요청"""

    token: str


class TokenResponse(BaseModel):
    """토큰 API 응답"""

    success: bool
    message: Optional[str] = None
    error: Optional[str] = None


def create_claude_auth_router(env_path: Optional[Path] = None) -> APIRouter:
    """Claude OAuth 토큰 라우터 생성

    Args:
        env_path: .env 파일 경로. None이면 CWD/.env 사용

    Returns:
        설정된 APIRouter
    """
    router = APIRouter(prefix="/auth/claude", tags=["claude-auth"])

    def _get_env_path() -> Path:
        return env_path if env_path is not None else get_env_path()

    @router.post("/token", response_model=TokenResponse)
    async def set_token(
        request: SetTokenRequest, _: str = Depends(verify_token)
    ) -> TokenResponse:
        """OAuth 토큰 설정

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

    return router
