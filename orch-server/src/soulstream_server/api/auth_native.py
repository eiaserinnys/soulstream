"""POST /api/auth/google/native — 네이티브 앱용 Google ID token → soul jwt 발급.

Expo auth-session 등 모바일 PKCE flow에서 클라이언트가 Google에서 받은 ID token을
이 엔드포인트에 제출하면, 서버가 audience 검증 후 soul jwt를 JSON body로 반환한다.

cookie는 발급하지 않음 — 네이티브 앱은 SecureStore(iOS Keychain) 사용이 표준이다.

설계:
- OAuth 라우터(/api/auth/google, /api/auth/google/callback)는 cookie 발급 흐름 유지
  (대시보드 웹 인증용). 본 엔드포인트는 모바일 전용 추가 흐름.
- 두 흐름 모두 generate_token으로 동일한 jwt 형식을 발급하므로 정본이 분산되지 않는다.
- 인증 전 단계 엔드포인트이므로 verify_auth dependency는 걸지 않음 — main.py에서
  `_mount_api_routers` 내부에 dependencies 없이 mount해야 한다 (auth_bearer_router와
  같은 패턴).

보안:
- audience를 iOS client ID로 엄격히 검증한다. None으로 두면 cross-app token 재사용
  공격이 가능하므로 절대 None으로 두지 않는다.
- 라우터 팩토리는 client_id를 필수 인자로 받으며, main.py에서 빈 문자열일 때
  라우터 자체를 등록하지 않도록 게이트를 둔다.
"""

from fastapi import APIRouter, HTTPException
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token
from pydantic import BaseModel

from soul_common.auth.jwt import generate_token


class NativeAuthRequest(BaseModel):
    """모바일 클라이언트가 제출하는 Google ID token."""

    id_token: str


def create_native_auth_router(
    google_ios_client_id: str,
    jwt_secret: str,
) -> APIRouter:
    """네이티브 앱용 ID token → jwt 발급 라우터 팩토리.

    Args:
        google_ios_client_id: iOS OAuth client ID (audience 검증용). 빈 문자열이면
            라우터를 사용해서는 안 된다 (호출자가 등록을 건너뛰어야 함).
        jwt_secret: soul jwt 서명 키.

    Returns:
        POST /api/auth/google/native 라우터.
    """
    router = APIRouter()

    @router.post("/api/auth/google/native")
    async def native_google_auth(body: NativeAuthRequest) -> dict:
        try:
            idinfo = id_token.verify_oauth2_token(
                body.id_token,
                google_requests.Request(),
                audience=google_ios_client_id,  # cross-app token 재사용 방지
            )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=f"Invalid ID token: {e}")

        email = idinfo.get("email")
        if not email:
            raise HTTPException(status_code=400, detail="ID token missing email")

        jwt_token = generate_token(
            {
                "email": email,
                "name": idinfo.get("name", ""),
                "picture": idinfo.get("picture", ""),
            },
            jwt_secret,
        )
        return {"token": jwt_token}

    return router
