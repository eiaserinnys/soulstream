"""Push 토큰 등록/해제 API.

JWT 인증으로만 접근 가능 (Bearer 정적 토큰 모드는 거부).
사용자 식별은 JWT 페이로드의 email — packages/soul-common oauth_routes.py 참조.
"""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from soulstream_server.push.repository import PushRepository


class RegisterRequest(BaseModel):
    token: str
    deviceId: str


def _require_jwt_user(req: Request) -> dict:
    """Bearer 정적 토큰 모드는 auth_user를 채우지 않으므로 거부.

    JWT 쿠키 또는 native JWT(`/api/auth/google/native`)로 들어온 요청만 통과.
    """
    user = getattr(req.state, "auth_user", None)
    if not user or not user.get("email"):
        raise HTTPException(
            status_code=401,
            detail="JWT authentication required for push registration",
        )
    return user


def create_push_router(
    repo: PushRepository,
    dependencies: list | None = None,
) -> APIRouter:
    router = APIRouter(
        prefix="/api/push",
        tags=["push"],
        dependencies=dependencies or [],
    )

    @router.post("/register")
    async def register(req: Request, body: RegisterRequest) -> dict:
        user = _require_jwt_user(req)
        await repo.upsert_token(user["email"], body.deviceId, body.token)
        return {"ok": True}

    @router.delete("/register/{device_id}")
    async def deregister(req: Request, device_id: str) -> dict:
        user = _require_jwt_user(req)
        await repo.delete_token(user["email"], device_id)
        return {"ok": True}

    return router
