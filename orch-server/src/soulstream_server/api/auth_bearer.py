"""
/api/auth/token 엔드포인트 — Native JWT handoff

iOS 앱(soul-app) 등 React Native 네이티브 클라이언트가 WebView OAuth 완료 후
WebView 내 JS로 이 엔드포인트를 호출하여, HttpOnly 쿠키에 저장된 JWT 값을
응답 바디로 받아 네이티브 저장소(Keychain 등)로 옮길 수 있게 한다.

보안: 라우터 자체가 verify_auth로 보호되므로, 이미 인증된 세션(쿠키 OR Bearer)
에서만 토큰이 발급된다. 인증되지 않은 요청은 401.

정본 원칙: `COOKIE_NAME`은 `soul_common.auth.jwt`에서 import한다.
"""

from fastapi import APIRouter, Depends, HTTPException, Request

from soul_common.auth.jwt import COOKIE_NAME
from soulstream_server.api.auth import verify_auth

router = APIRouter()


@router.get("/api/auth/token", dependencies=[Depends(verify_auth)])
async def get_auth_token(request: Request) -> dict:
    """현재 JWT 쿠키 값 또는 Bearer 토큰 값을 응답 바디로 반환한다.

    WebView OAuth 완료 후 네이티브 측이 쿠키에 접근할 수 없는 환경(RN)에서
    JWT를 네이티브 저장소로 이동시키기 위한 엔드포인트.

    라우터 수준에서 verify_auth로 보호되므로, 쿠키 또는 Bearer 중 하나로
    이미 인증된 상태여야만 여기 도달한다. 즉 이 응답은 호출자가 이미 가지고
    있는 자격 증명을 되돌려 주는 것이므로 추가적인 권한 확장은 없다.

    Returns:
        {"token": "<jwt 또는 bearer 값>"}

    Raises:
        HTTPException(401): verify_auth는 통과했지만 쿠키도 Authorization 헤더도
            없는 경우. (이론적으로 verify_auth가 통과했다면 둘 중 하나는 존재해야
            하므로 방어적 에러.)
    """
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        # Bearer로 들어온 경우 Authorization 헤더 값을 그대로 돌려줌 (fallback)
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            token = auth[7:]
    if not token:
        raise HTTPException(status_code=401, detail="No auth token in session")
    return {"token": token}


__all__ = ["router"]
