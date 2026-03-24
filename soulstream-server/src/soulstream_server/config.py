"""
Settings — 환경변수 기반 설정.
"""

import os
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """soulstream-server 설정."""

    # Server
    host: str
    port: int

    # Database
    database_url: str

    # Dashboard
    dashboard_dir: str = ""

    # Google OAuth
    google_client_id: str = ""
    google_client_secret: str = ""
    google_callback_url: str = ""
    allowed_email: str = ""
    jwt_secret: str = ""

    # Environment
    environment: str

    @property
    def is_development(self) -> bool:
        return self.environment.lower() in ("development", "dev")

    @property
    def is_auth_enabled(self) -> bool:
        return bool(self.google_client_id)

    model_config = {"env_file": ".env", "extra": "ignore"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
