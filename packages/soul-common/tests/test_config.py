"""BaseOAuthSettings 단위 테스트."""

import os
import pytest
from soul_common.config import BaseOAuthSettings


class ConcreteSettings(BaseOAuthSettings):
    """테스트용 구체 클래스."""
    pass


class TestBaseOAuthSettings:
    def test_is_development_with_development(self, monkeypatch):
        monkeypatch.setenv("ENVIRONMENT", "development")
        s = ConcreteSettings()
        assert s.is_development is True

    def test_is_development_with_dev(self, monkeypatch):
        monkeypatch.setenv("ENVIRONMENT", "dev")
        s = ConcreteSettings()
        assert s.is_development is True

    def test_is_development_with_dev_uppercase(self, monkeypatch):
        monkeypatch.setenv("ENVIRONMENT", "Dev")
        s = ConcreteSettings()
        assert s.is_development is True

    def test_is_development_with_production(self, monkeypatch):
        monkeypatch.setenv("ENVIRONMENT", "production")
        s = ConcreteSettings()
        assert s.is_development is False

    def test_is_development_with_test(self, monkeypatch):
        monkeypatch.setenv("ENVIRONMENT", "test")
        s = ConcreteSettings()
        assert s.is_development is False

    def test_is_auth_enabled_with_client_id(self, monkeypatch):
        monkeypatch.setenv("ENVIRONMENT", "development")
        monkeypatch.setenv("GOOGLE_CLIENT_ID", "my-client-id")
        s = ConcreteSettings()
        assert s.is_auth_enabled is True

    def test_is_auth_enabled_without_client_id(self, monkeypatch):
        monkeypatch.setenv("ENVIRONMENT", "development")
        monkeypatch.delenv("GOOGLE_CLIENT_ID", raising=False)
        s = ConcreteSettings()
        assert s.is_auth_enabled is False

    def test_oauth_fields_default_empty_string(self, monkeypatch):
        monkeypatch.setenv("ENVIRONMENT", "development")
        # 실제 환경에 OAuth 키가 설정돼 있을 수 있으므로 명시적으로 비움
        monkeypatch.delenv("GOOGLE_CLIENT_ID", raising=False)
        monkeypatch.delenv("GOOGLE_CLIENT_SECRET", raising=False)
        monkeypatch.delenv("GOOGLE_CALLBACK_URL", raising=False)
        monkeypatch.delenv("ALLOWED_EMAIL", raising=False)
        monkeypatch.delenv("JWT_SECRET", raising=False)
        s = ConcreteSettings()
        assert s.google_client_id == ""
        assert s.google_client_secret == ""
        assert s.google_callback_url == ""
        assert s.allowed_email == ""
        assert s.jwt_secret == ""

    def test_environment_required(self, monkeypatch):
        """environment 기본값 없음 — 설정되지 않으면 ValidationError 발생."""
        monkeypatch.delenv("ENVIRONMENT", raising=False)
        with pytest.raises(Exception):  # pydantic ValidationError
            ConcreteSettings()
