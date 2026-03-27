"""공통 OAuth 설정 기반 클래스.

soul-server와 soulstream-server 양쪽에서 공유하는 OAuth/환경 관련 설정을
pydantic-settings BaseSettings 기반으로 정의한다.
"""

from pydantic_settings import BaseSettings


class BaseOAuthSettings(BaseSettings):
    """OAuth 및 환경 설정 공통 기반 클래스.

    soulstream-server: 이 클래스를 직접 상속하여 Settings 정의.
    soul-server: @dataclass 기반 제약으로 상속 불가 — property 로직만 동일하게 유지.
    """

    # OAuth
    google_client_id: str = ""
    google_client_secret: str = ""
    google_callback_url: str = ""
    allowed_email: str = ""
    jwt_secret: str = ""

    # Environment — 기본값 없음: .env에 필수 (설계 원칙 4: 명시적 실패)
    environment: str

    @property
    def is_development(self) -> bool:
        """개발 환경 여부. "development" 또는 "dev" 값을 허용."""
        return self.environment.lower() in ("development", "dev")

    @property
    def is_auth_enabled(self) -> bool:
        """Google OAuth 인증 활성화 여부."""
        return bool(self.google_client_id)
