"""
OAuth Profiles API - OAuth 토큰 프로필 목록 조회

GET /api/oauth-profiles — 등록된 OAuth 토큰 프로필 이름 목록 반환
토큰 값은 절대 노출하지 않음.
degraded mode(OAuthTokenRegistry 빈 상태)에서는 빈 목록 반환.
"""

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()


class OAuthProfileInfo(BaseModel):
    name: str


class OAuthProfilesResponse(BaseModel):
    profiles: list[OAuthProfileInfo]


@router.get("/api/oauth-profiles", response_model=OAuthProfilesResponse)
async def list_oauth_profiles():
    """등록된 OAuth 토큰 프로필 이름 목록 반환.
    토큰 값은 보안상 미노출.
    degraded mode(OAuthTokenRegistry 빈 상태)에서는 빈 목록 반환.
    """
    from soul_server.main import get_oauth_token_registry
    registry = get_oauth_token_registry()
    profiles = [OAuthProfileInfo(name=name) for name in registry.list_names()]
    return OAuthProfilesResponse(profiles=profiles)
