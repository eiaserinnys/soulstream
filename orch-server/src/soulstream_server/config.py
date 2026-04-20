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

    # Atom 연동 (선택 사항 — 미설정/ATOM_ENABLED=false 시 비활성)
    atom_enabled: bool = False
    atom_server_url: str = ""   # 예: https://atom.eiaserinnys.me
    atom_api_key: str = ""      # x-api-key 헤더 값
    atom_root_node_id: str | None = None  # 미설정 시 atom 전체 루트 노드를 표시

    # Bearer 토큰 인증 — 프로덕션에서는 필수. 미설정 시 verify_token이 CONFIG_ERROR 반환.
    # 개발 모드(environment != "production")에서는 빈 값이면 인증 우회.
    auth_bearer_token: str = ""

    # OAuth, environment, is_development, is_auth_enabled 는 BaseOAuthSettings에서 상속

    model_config = {"env_file": ".env", "extra": "ignore"}

    @property
    def is_production(self) -> bool:
        """프로덕션 환경 여부. verify_token에서 토큰 미설정 시 CONFIG_ERROR 판정에 사용."""
        return self.environment.lower() == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()
