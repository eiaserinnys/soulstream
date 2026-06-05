"""
Settings — 환경변수 기반 설정.
"""

import json
from functools import lru_cache
from typing import Annotated

from pydantic import field_validator
from pydantic_settings import NoDecode

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

    # Board asset uploads (Cloudflare R2, S3-compatible).
    # Empty values disable `/api/board/{folderId}/assets/*` until operations
    # provision the board-assets bucket and credentials.
    r2_board_assets_access_key_id: str = ""
    r2_board_assets_secret_access_key: str = ""
    r2_board_assets_bucket: str = ""
    r2_board_assets_endpoint: str = ""

    # Atom 연동 (선택 사항 — 미설정/ATOM_ENABLED=false 시 비활성)
    atom_enabled: bool = False
    atom_server_url: str = ""   # 예: https://atom.eiaserinnys.me
    atom_api_key: str = ""      # x-api-key 헤더 값
    atom_root_node_id: str | None = None  # 미설정 시 atom 전체 루트 노드를 표시

    # Bearer 토큰 인증 — 프로덕션에서는 필수. 미설정 시 verify_token이 CONFIG_ERROR 반환.
    # 개발 모드(environment != "production")에서는 빈 값이면 인증 우회.
    auth_bearer_token: str = ""

    # CORS — 환경변수 기반 허용 origin 목록.
    # 프로덕션(is_production=True)에서 빈 리스트이면 main._check_production_cors가
    # startup 시 RuntimeError로 즉시 실패한다 (fail-fast).
    # NoDecode: pydantic-settings의 기본 JSON 디코딩을 건너뛰고, _parse_cors validator가
    # CSV / JSON 배열 / 빈 문자열 3가지를 직접 처리한다.
    cors_allowed_origins: Annotated[list[str], NoDecode] = []

    # OAuth, environment, is_development, is_auth_enabled 는 BaseOAuthSettings에서 상속

    model_config = {"env_file": ".env", "extra": "ignore"}

    @field_validator("cors_allowed_origins", mode="before")
    @classmethod
    def _parse_cors(cls, v):
        """.env에서 CSV 문자열로 받은 경우 list로 변환.

        pydantic-settings는 기본적으로 list[str]을 JSON 배열로 파싱한다.
        운영 편의를 위해 CSV 형식(`https://a,https://b`)도 허용한다.
        """
        if isinstance(v, str):
            s = v.strip()
            if not s:
                return []
            # JSON 배열로 먼저 시도 (backward compat)
            if s.startswith("["):
                return json.loads(s)
            return [item.strip() for item in v.split(",") if item.strip()]
        return v

    @property
    def is_production(self) -> bool:
        """프로덕션 환경 여부. verify_token에서 토큰 미설정 시 CONFIG_ERROR 판정에 사용."""
        return self.environment.lower() == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()
