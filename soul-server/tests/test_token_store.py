"""
test_token_store - OAuth 토큰 저장/삭제 단위 테스트
"""

import os
from pathlib import Path

import pytest

from soul_server.api.claude_auth.token_store import (
    TOKEN_ENV_KEY,
    save_oauth_token,
    delete_oauth_token,
    get_oauth_token,
)


@pytest.fixture
def env_path(tmp_path: Path) -> Path:
    """임시 .env 파일 경로"""
    return tmp_path / ".env"


@pytest.fixture(autouse=True)
def cleanup_env():
    """테스트 전후 환경변수 정리"""
    # 테스트 전 삭제
    if TOKEN_ENV_KEY in os.environ:
        del os.environ[TOKEN_ENV_KEY]

    yield

    # 테스트 후 삭제
    if TOKEN_ENV_KEY in os.environ:
        del os.environ[TOKEN_ENV_KEY]


class TestSaveOAuthToken:
    """save_oauth_token 테스트"""

    def test_save_to_env_and_file(self, env_path: Path):
        """환경변수와 파일 모두에 저장"""
        token = "sk-ant-oat01-test-token"
        save_oauth_token(token, env_path=env_path)

        # 환경변수에 저장됨
        assert os.environ.get(TOKEN_ENV_KEY) == token

        # 파일에 저장됨
        content = env_path.read_text()
        assert f"{TOKEN_ENV_KEY}={token}" in content

    def test_save_creates_file(self, env_path: Path):
        """파일이 없으면 생성"""
        assert not env_path.exists()

        save_oauth_token("sk-ant-oat01-new", env_path=env_path)

        assert env_path.exists()
        content = env_path.read_text()
        assert f"{TOKEN_ENV_KEY}=sk-ant-oat01-new" in content

    def test_save_replaces_existing(self, env_path: Path):
        """기존 토큰 교체"""
        env_path.write_text(f"{TOKEN_ENV_KEY}=old-token\nOTHER_VAR=value\n")

        save_oauth_token("sk-ant-oat01-new", env_path=env_path)

        content = env_path.read_text()
        assert f"{TOKEN_ENV_KEY}=sk-ant-oat01-new" in content
        assert "old-token" not in content
        assert "OTHER_VAR=value" in content

    def test_save_appends_if_not_exists(self, env_path: Path):
        """토큰이 없으면 추가"""
        env_path.write_text("OTHER_VAR=value\n")

        save_oauth_token("sk-ant-oat01-new", env_path=env_path)

        content = env_path.read_text()
        assert f"{TOKEN_ENV_KEY}=sk-ant-oat01-new" in content
        assert "OTHER_VAR=value" in content

    def test_save_handles_no_newline(self, env_path: Path):
        """마지막 줄에 개행 없을 때 (주석 포함)"""
        env_path.write_text("OTHER_VAR=value")  # 개행 없음

        save_oauth_token("sk-ant-oat01-new", env_path=env_path)

        content = env_path.read_text()
        # 원격 버전은 주석을 추가하므로 4줄: OTHER_VAR, 빈줄, 주석, 토큰
        assert "OTHER_VAR=value" in content
        assert f"{TOKEN_ENV_KEY}=sk-ant-oat01-new" in content
        assert "# Claude Code OAuth Token (auto-generated)" in content


class TestDeleteOAuthToken:
    """delete_oauth_token 테스트"""

    def test_delete_from_env_and_file(self, env_path: Path):
        """환경변수와 파일 모두에서 삭제"""
        os.environ[TOKEN_ENV_KEY] = "sk-ant-oat01-test"
        env_path.write_text(f"{TOKEN_ENV_KEY}=sk-ant-oat01-test\nOTHER_VAR=value\n")

        result = delete_oauth_token(env_path=env_path)

        assert result is True
        assert TOKEN_ENV_KEY not in os.environ

        content = env_path.read_text()
        assert TOKEN_ENV_KEY not in content
        assert "OTHER_VAR=value" in content

    def test_delete_env_only(self, env_path: Path):
        """환경변수만 있을 때"""
        os.environ[TOKEN_ENV_KEY] = "sk-ant-oat01-test"
        # 파일 없음

        result = delete_oauth_token(env_path=env_path)

        assert result is True
        assert TOKEN_ENV_KEY not in os.environ

    def test_delete_file_only(self, env_path: Path):
        """파일에만 있을 때"""
        env_path.write_text(f"{TOKEN_ENV_KEY}=sk-ant-oat01-test\n")
        # 환경변수 없음

        result = delete_oauth_token(env_path=env_path)

        assert result is True
        content = env_path.read_text()
        assert TOKEN_ENV_KEY not in content

    def test_delete_not_found(self, env_path: Path):
        """토큰이 없을 때"""
        env_path.write_text("OTHER_VAR=value\n")

        result = delete_oauth_token(env_path=env_path)

        assert result is False

    def test_delete_cleans_empty_lines(self, env_path: Path):
        """삭제 후 빈 줄 정리"""
        env_path.write_text(f"VAR1=a\n{TOKEN_ENV_KEY}=token\nVAR2=b\n")

        delete_oauth_token(env_path=env_path)

        content = env_path.read_text()
        # 연속된 빈 줄이 없어야 함
        assert "\n\n\n" not in content


class TestGetOAuthToken:
    """get_oauth_token 테스트"""

    def test_get_existing_token(self):
        """토큰이 있을 때"""
        os.environ[TOKEN_ENV_KEY] = "sk-ant-oat01-test"

        token = get_oauth_token()

        assert token == "sk-ant-oat01-test"

    def test_get_no_token(self):
        """토큰이 없을 때"""
        token = get_oauth_token()

        assert token is None
