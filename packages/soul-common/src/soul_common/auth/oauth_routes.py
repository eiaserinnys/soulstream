"""
OAuth 라우트 팩토리 — /api/auth/*

Google OAuth Authorization Code Flow + JWT 쿠키 세션.
서비스별 설정을 팩토리 파라미터로 주입받아 라우터를 생성한다.
"""

import logging
import secrets
from typing import Any, Callable, Coroutine
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse

from soul_common.auth.jwt import COOKIE_NAME, generate_token, verify_token

# CSRF state 쿠키 이름
OAUTH_STATE_COOKIE = "soul_oauth_state"
# 로그인 후 복귀 경로 쿠키
RETURN_TO_COOKIE = "soul_return_to"

logger = logging.getLogger(__name__)


def create_oauth_router(
    google_client_id: str,
    google_client_secret: str,
    callback_url: str,
    allowed_email: str,
    jwt_secret: str,
    cookie_name: str = COOKIE_NAME,
    is_development: bool = False,
) -> APIRouter:
    """Google OAuth 라우터를 생성한다.

    Args:
        google_client_id: Google OAuth Client ID
        google_client_secret: Google OAuth Client Secret
        callback_url: OAuth 콜백 URL (절대 또는 상대 경로)
        allowed_email: 허용된 이메일 주소
        jwt_secret: JWT 서명 키
        cookie_name: JWT 쿠키 이름
        is_development: 개발 모드 여부 (dev-login 허용)

    Returns:
        설정이 주입된 APIRouter
    """
    router = APIRouter()
    auth_enabled = bool(google_client_id)

    def _get_callback_url(request: Request) -> str:
        if callback_url.startswith("http"):
            return callback_url
        base = str(request.base_url).rstrip("/")
        return f"{base}{callback_url}"

    @router.get("/api/auth/config")
    async def auth_config():
        return {
            "authEnabled": auth_enabled,
            "devModeEnabled": is_development,
        }

    @router.get("/api/auth/google")
    async def auth_google(request: Request, return_to: str = ""):
        if not auth_enabled:
            raise HTTPException(status_code=404, detail="Auth not enabled")

        state = secrets.token_urlsafe(32)
        params = {
            "client_id": google_client_id,
            "redirect_uri": _get_callback_url(request),
            "response_type": "code",
            "scope": "openid email profile",
            "access_type": "offline",
            "state": state,
        }
        url = f"https://accounts.google.com/o/oauth2/v2/auth?{urlencode(params)}"
        response = RedirectResponse(url)
        response.set_cookie(
            OAUTH_STATE_COOKIE,
            state,
            httponly=True,
            samesite="lax",
            max_age=600,
            secure=request.url.scheme == "https",
        )
        if return_to and return_to.startswith("/") and not return_to.startswith("//"):
            response.set_cookie(
                RETURN_TO_COOKIE,
                return_to,
                httponly=True,
                samesite="lax",
                max_age=600,
                secure=request.url.scheme == "https",
            )
        return response

    @router.get("/api/auth/google/callback")
    async def auth_callback(code: str, state: str, request: Request):
        expected_state = request.cookies.get(OAUTH_STATE_COOKIE)
        if not expected_state or state != expected_state:
            logger.warning("OAuth state mismatch — possible CSRF attack")
            return RedirectResponse("/?error=auth_failed")

        try:
            async with httpx.AsyncClient() as client:
                token_resp = await client.post(
                    "https://oauth2.googleapis.com/token",
                    data={
                        "code": code,
                        "client_id": google_client_id,
                        "client_secret": google_client_secret,
                        "redirect_uri": _get_callback_url(request),
                        "grant_type": "authorization_code",
                    },
                )
                if token_resp.status_code != 200:
                    logger.warning("Token exchange failed: %s %.200s", token_resp.status_code, token_resp.text)
                    return RedirectResponse("/?error=auth_failed")
                tokens = token_resp.json()

                userinfo_resp = await client.get(
                    "https://www.googleapis.com/oauth2/v2/userinfo",
                    headers={"Authorization": f"Bearer {tokens['access_token']}"},
                )
                if userinfo_resp.status_code != 200:
                    logger.warning("Userinfo fetch failed: %s", userinfo_resp.status_code)
                    return RedirectResponse("/?error=auth_failed")
                userinfo = userinfo_resp.json()

        except Exception as e:
            logger.exception("OAuth callback error: %s", e)
            return RedirectResponse("/?error=auth_failed")

        if not allowed_email or userinfo.get("email") != allowed_email:
            logger.warning("Email not allowed: %s", userinfo.get("email"))
            return RedirectResponse("/?error=no_user")

        jwt_token = generate_token(
            {
                "email": userinfo["email"],
                "name": userinfo.get("name", ""),
                "picture": userinfo.get("picture", ""),
            },
            jwt_secret,
        )
        return_to = request.cookies.get(RETURN_TO_COOKIE, "/")
        if not return_to.startswith("/") or return_to.startswith("//"):
            return_to = "/"
        response = RedirectResponse(return_to)
        response.set_cookie(
            cookie_name,
            jwt_token,
            httponly=True,
            samesite="lax",
            max_age=7 * 24 * 3600,
            secure=request.url.scheme == "https",
        )
        response.delete_cookie(OAUTH_STATE_COOKIE)
        response.delete_cookie(RETURN_TO_COOKIE)
        return response

    @router.get("/api/auth/status")
    async def auth_status(request: Request):
        if not auth_enabled:
            return {"authenticated": True, "user": None}

        token = request.cookies.get(cookie_name)
        if not token:
            return {"authenticated": False, "user": None}

        payload = verify_token(token, jwt_secret)
        if not payload:
            return {"authenticated": False, "user": None}

        return {
            "authenticated": True,
            "user": {
                "email": payload["email"],
                "name": payload.get("name", ""),
                "picture": payload.get("picture", ""),
            },
        }

    @router.post("/api/auth/logout")
    async def auth_logout():
        response = JSONResponse({"success": True})
        response.delete_cookie(cookie_name)
        return response

    @router.post("/api/auth/dev-login")
    async def dev_login(request: Request):
        if not is_development:
            raise HTTPException(status_code=403, detail="Dev login not available")
        if not jwt_secret:
            raise HTTPException(status_code=500, detail="JWT_SECRET not configured")

        body = await request.json()
        email = body.get("email", "")
        name = body.get("name", "Developer")

        if not email:
            raise HTTPException(status_code=400, detail="Email is required")

        jwt_token = generate_token({"email": email, "name": name}, jwt_secret)
        response = JSONResponse({"success": True})
        response.set_cookie(
            cookie_name,
            jwt_token,
            httponly=True,
            samesite="lax",
            max_age=7 * 24 * 3600,
        )
        return response

    return router


def create_auth_dependency(
    jwt_secret: str,
    cookie_name: str = COOKIE_NAME,
    auth_enabled: bool = True,
) -> Callable[[Request], Coroutine[Any, Any, dict | None]]:
    """FastAPI Depends로 사용할 인증 검증 함수를 반환한다.

    Args:
        jwt_secret: JWT 서명 키
        cookie_name: JWT 쿠키 이름
        auth_enabled: 인증 활성화 여부

    Returns:
        async 함수: Request → dict | None
    """
    async def _require_auth(request: Request) -> dict | None:
        if not auth_enabled:
            return None

        token = request.cookies.get(cookie_name)
        if not token:
            auth_header = request.headers.get("authorization", "")
            if auth_header.startswith("Bearer "):
                token = auth_header[7:]

        if not token:
            raise HTTPException(status_code=401, detail="Authentication required")

        payload = verify_token(token, jwt_secret)
        if not payload:
            raise HTTPException(status_code=401, detail="Invalid or expired token")

        request.state.auth_user = payload
        return payload

    return _require_auth
