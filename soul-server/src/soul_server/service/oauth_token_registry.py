"""
OAuthTokenRegistry - OAuth 토큰 프로필 관리

oauth_tokens.yaml에서 OAuth 토큰 프로필을 로딩하여 레지스트리로 제공한다.
세션별 CLAUDE_CODE_OAUTH_TOKEN 환경변수 오버라이드에 사용한다.
"""

from __future__ import annotations
from dataclasses import dataclass


@dataclass
class OAuthTokenProfile:
    name: str
    token: str


class OAuthTokenRegistry:
    def __init__(self, profiles: list[OAuthTokenProfile]) -> None:
        self._profiles: dict[str, OAuthTokenProfile] = {p.name: p for p in profiles}

    def get(self, name: str) -> OAuthTokenProfile | None:
        return self._profiles.get(name)

    def has(self, name: str) -> bool:
        return name in self._profiles

    def list_names(self) -> list[str]:
        return list(self._profiles.keys())

    def is_empty(self) -> bool:
        return len(self._profiles) == 0


def load_oauth_token_registry(path: str) -> OAuthTokenRegistry:
    """oauth_tokens.yaml에서 OAuthTokenRegistry를 로딩한다.

    파일이 없으면 빈 레지스트리를 반환한다 (degraded mode).
    """
    if not path:
        return OAuthTokenRegistry([])
    import yaml
    try:
        with open(path, encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        profiles = [OAuthTokenProfile(**p) for p in data.get("profiles", [])]
        return OAuthTokenRegistry(profiles)
    except FileNotFoundError:
        return OAuthTokenRegistry([])
