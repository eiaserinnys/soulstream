"""
Dashboard 인증 라우트 — /api/auth/*

Google OAuth Authorization Code Flow + JWT 쿠키 세션.
프론트엔드(AuthProvider, Login)가 호출하는 엔드포인트를 제공한다.

GOOGLE_CLIENT_ID 미설정 시:
  - /api/auth/config → { authEnabled: false }
  - 다른 auth 엔드포인트는 404 또는 미사용 상태

GOOGLE_CLIENT_ID 설정 시:
  - /api/auth/google → Google OAuth 시작 (리다이렉트)
  - /api/auth/google/callback → 콜백 처리 → JWT 쿠키 설정
  - /api/auth/status → 현재 인증 상태
  - /api/auth/logout → 쿠키 삭제
  - /api/auth/dev-login → 개발 환경 전용 로그인
"""

import logging
import secrets
from urllib.parse import urlencode, quote, unquote

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse

from soul_server.config import get_settings
from soul_server.dashboard.auth import COOKIE_NAME, generate_token, verify_token

# CSRF state 쿠키 이름
OAUTH_STATE_COOKIE = "soul_oauth_state"
# 로그인 후 복귀 경로 쿠키
RETURN_TO_COOKIE = "soul_return_to"

logger = logging.getLogger(__name__)

router = APIRouter()


def _get_callback_url(request: Request) -> str:
    """OAuth 콜백 절대 URL을 생성한다.

    settings.google_callback_url이 절대 URL이면 그대로 사용.
    상대 경로이면 request의 base URL과 결합한다.
    리버스 프록시 뒤에서는 X-Forwarded-Proto/Host 헤더를 존중한다
    (FastAPI/Starlette이 Request.base_url에 자동 반영).
    """
    settings = get_settings()
    callback = settings.google_callback_url
    if callback.startswith("http"):
        return callback
    base = str(request.base_url).rstrip("/")
    return f"{base}{callback}"


# === /api/auth/config ===

@router.get("/api/auth/config")
async def auth_config():
    """인증 설정 정보. 프론트엔드 AuthProvider가 초기화 시 호출."""
    settings = get_settings()
    return {
        "authEnabled": settings.is_auth_enabled,
        "devModeEnabled": settings.is_development,
    }


# === /api/auth/google ===

@router.get("/api/auth/google")
async def auth_google(request: Request, return_to: str = ""):
    """Google OAuth 시작 — Google authorize URL로 리다이렉트."""
    settings = get_settings()
    if not settings.is_auth_enabled:
        raise HTTPException(status_code=404, detail="Auth not enabled")

    # CSRF 방지: 랜덤 state 생성 → 쿠키에 저장 → Google에 전달
    state = secrets.token_urlsafe(32)

    params = {
        "client_id": settings.google_client_id,
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
        max_age=600,  # 10분
        secure=request.url.scheme == "https",
    )
    # 로그인 후 복귀 경로 저장 (경로만 허용 — open redirect 방지)
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


# === /api/auth/google/callback ===

@router.get("/api/auth/google/callback")
async def auth_callback(code: str, state: str, request: Request):
    """Google OAuth 콜백 — code를 token으로 교환하고 JWT 쿠키를 설정한다."""
    settings = get_settings()

    # CSRF state 검증
    expected_state = request.cookies.get(OAUTH_STATE_COOKIE)
    if not expected_state or state != expected_state:
        logger.warning("OAuth state mismatch — possible CSRF attack")
        return RedirectResponse("/?error=auth_failed")

    try:
        async with httpx.AsyncClient() as client:
            # 1. code → token 교환
            token_resp = await client.post(
                "https://oauth2.googleapis.com/token",
                data={
                    "code": code,
                    "client_id": settings.google_client_id,
                    "client_secret": settings.google_client_secret,
                    "redirect_uri": _get_callback_url(request),
                    "grant_type": "authorization_code",
                },
            )
            if token_resp.status_code != 200:
                logger.warning("Token exchange failed: %s %.200s", token_resp.status_code, token_resp.text)
                return RedirectResponse("/?error=auth_failed")
            tokens = token_resp.json()

            # 2. userinfo 조회
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

    # 3. ALLOWED_EMAIL 검증 — 미설정이면 거부 (validate()에서 필수화했지만 자체 완결)
    if not settings.allowed_email or userinfo.get("email") != settings.allowed_email:
        logger.warning("Email not allowed: %s", userinfo.get("email"))
        return RedirectResponse("/?error=no_user")

    # 4. JWT 생성 → httpOnly 쿠키 설정 → 원래 경로로 리다이렉트
    jwt_token = generate_token(
        {
            "email": userinfo["email"],
            "name": userinfo.get("name", ""),
            "picture": userinfo.get("picture", ""),
        },
        settings.jwt_secret,
    )
    # 복귀 경로 복원 (쿠키에서 읽고, 경로 형태가 아니면 / 로 폴백)
    return_to = request.cookies.get(RETURN_TO_COOKIE, "/")
    if not return_to.startswith("/") or return_to.startswith("//"):
        return_to = "/"
    response = RedirectResponse(return_to)
    response.set_cookie(
        COOKIE_NAME,
        jwt_token,
        httponly=True,
        samesite="lax",
        max_age=7 * 24 * 3600,
        secure=request.url.scheme == "https",
    )
    # 임시 쿠키 정리
    response.delete_cookie(OAUTH_STATE_COOKIE)
    response.delete_cookie(RETURN_TO_COOKIE)
    return response


# === /api/auth/status ===

@router.get("/api/auth/status")
async def auth_status(request: Request):
    """현재 인증 상태. 프론트엔드 AuthProvider가 호출."""
    settings = get_settings()
    if not settings.is_auth_enabled:
        return {"authenticated": True, "user": None}

    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return {"authenticated": False, "user": None}

    payload = verify_token(token, settings.jwt_secret)
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


# === /api/auth/logout ===

@router.post("/api/auth/logout")
async def auth_logout():
    """로그아웃 — JWT 쿠키 삭제."""
    response = JSONResponse({"success": True})
    response.delete_cookie(COOKIE_NAME)
    return response


# === /api/auth/dev-login ===

@router.post("/api/auth/dev-login")
async def dev_login(request: Request):
    """개발 환경 전용 로그인 — 이메일로 JWT 발급."""
    settings = get_settings()
    if not settings.is_development:
        raise HTTPException(status_code=403, detail="Dev login not available")
    if not settings.jwt_secret:
        raise HTTPException(status_code=500, detail="JWT_SECRET not configured")

    body = await request.json()
    email = body.get("email", "")
    name = body.get("name", "Developer")

    if not email:
        raise HTTPException(status_code=400, detail="Email is required")

    jwt_token = generate_token({"email": email, "name": name}, settings.jwt_secret)
    response = JSONResponse({"success": True})
    response.set_cookie(
        COOKIE_NAME,
        jwt_token,
        httponly=True,
        samesite="lax",
        max_age=7 * 24 * 3600,
    )
    return response
