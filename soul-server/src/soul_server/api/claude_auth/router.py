"""
Claude Code OAuth 인증 API 라우터

엔드포인트:
- GET  /auth/claude/web/start     - PKCE OAuth 흐름 시작 (auth_url 반환)
- GET  /auth/claude/web/callback  - OAuth 콜백 수신 및 토큰 교환
- GET  /auth/claude/usage         - Anthropic 사용량 조회
- POST /auth/claude/token         - 토큰 직접 설정
- GET  /auth/claude/token         - 토큰 존재 여부 확인
- DELETE /auth/claude/token       - 토큰 삭제
- GET  /auth/claude/profiles      - 프로필 목록 조회
- POST /auth/claude/profiles/activate - 프로필 활성화
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from soul_server.api.auth import verify_token
from .pkce import generate_verifier, generate_challenge, generate_state
from .web_session import web_session_store
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

CLAUDE_OAUTH_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize"
CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"


# === Request/Response Models ===


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
    env_path: Path | None = None,
) -> APIRouter:
    """
    Claude Auth API 라우터 팩토리

    Args:
        env_path: .env 파일 경로 (None이면 기본 경로 사용)

    Returns:
        FastAPI APIRouter
    """
    router = APIRouter()

    def _get_env_path() -> Path:
        """env_path가 None이면 기본 경로 사용"""
        return env_path if env_path is not None else get_env_path()

    # === PKCE OAuth 웹 흐름 엔드포인트 ===

    @router.get("/web/start")
    async def web_start():
        """
        GET /auth/claude/web/start - PKCE OAuth 흐름 시작

        code_verifier를 생성하고 Claude OAuth 인증 URL로 직접 302 리다이렉트합니다.
        브라우저에서 직접 열어야 하므로 인증 토큰 없이 접근 가능합니다.
        """
        client_id = os.environ["CLAUDE_OAUTH_CLIENT_ID"]
        callback_url = os.environ["CLAUDE_OAUTH_CALLBACK_URL"]
        verifier = generate_verifier()
        challenge = generate_challenge(verifier)
        state = generate_state()
        web_session_store.create(state, verifier)
        params = {
            "client_id": client_id,
            "response_type": "code",
            "redirect_uri": callback_url,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "scope": "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
            "state": state,
        }
        return RedirectResponse(url=f"{CLAUDE_OAUTH_AUTHORIZE_URL}?{urlencode(params)}")

    @router.get("/web/callback")
    async def web_callback(code: str, state: str):
        """
        GET /auth/claude/web/callback - OAuth 콜백 수신

        Anthropic이 리디렉션하는 엔드포인트. verify_token 불필요.
        code_verifier로 토큰 교환 후 저장합니다.
        """
        session = web_session_store.pop(state)
        if session is None:
            raise HTTPException(status_code=400, detail="Invalid or expired OAuth state")
        client_id = os.environ["CLAUDE_OAUTH_CLIENT_ID"]
        callback_url = os.environ["CLAUDE_OAUTH_CALLBACK_URL"]
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                CLAUDE_OAUTH_TOKEN_URL,
                json={
                    "grant_type": "authorization_code",
                    "client_id": client_id,
                    "code": code,
                    "redirect_uri": callback_url,
                    "code_verifier": session.verifier,
                },
            )
            if resp.status_code != 200:
                raise HTTPException(
                    status_code=400, detail=f"Token exchange failed: {resp.text}"
                )
            data = resp.json()
        access_token = data["access_token"]
        save_oauth_token(access_token, _get_env_path())
        logger.info("Claude Code OAuth token saved via PKCE web flow")
        return RedirectResponse(url="/?claude_auth=success")

    @router.get("/usage")
    async def get_usage(_: str = Depends(verify_token)):
        """
        GET /auth/claude/usage - Anthropic 사용량 조회
        """
        token = get_oauth_token()
        if not token:
            raise HTTPException(status_code=404, detail="No OAuth token stored")
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                ANTHROPIC_USAGE_URL,
                headers={
                    "Authorization": f"Bearer {token}",
                    "anthropic-beta": "oauth-2025-04-20",
                },
            )
            if resp.status_code != 200:
                raise HTTPException(
                    status_code=resp.status_code,
                    detail=f"Usage API error: {resp.text}",
                )
            return resp.json()

    # === 직접 토큰 설정 엔드포인트 ===

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
