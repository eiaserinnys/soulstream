"""
Settings — 환경변수 기반 설정.
"""

from functools import lru_cache

from soul_common.config import BaseOAuthSettings


class Settings(BaseOAuthSettings):
    """soulstream-server 설정."""

    # Node identification — NODE_NAME env var. 다른 노드 세션 판별에 사용.
    node_name: str | None = None

    # Server
    host: str
    port: int

    # Database
    database_url: str

    # Dashboard
    dashboard_dir: str = ""

    # OAuth, environment, is_development, is_auth_enabled 는 BaseOAuthSettings에서 상속

    model_config = {"env_file": ".env", "extra": "ignore"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
