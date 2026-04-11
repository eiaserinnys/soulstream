"""
test_token_store - OAuth 토큰 저장/삭제 단위 테스트
"""

import json
import os
from pathlib import Path

import pytest

from soul_server.api.claude_auth.token_store import (
    TOKEN_ENV_KEY,
    REFRESH_TOKEN_ENV_KEY,
    CREDENTIALS_PATH,
    save_oauth_token,
    delete_oauth_token,
    get_oauth_token,
    save_credentials_json,
    delete_credentials_json,
    load_profiles,
    get_current_profile_name,
)


@pytest.fixture
def env_path(tmp_path: Path) -> Path:
    """임시 .env 파일 경로"""
    return tmp_path / ".env"


@pytest.fixture(autouse=True)
def cleanup_env():
    """테스트 전후 환경변수 정리"""
    # 테스트 전 삭제
    for key in (TOKEN_ENV_KEY, REFRESH_TOKEN_ENV_KEY):
        if key in os.environ:
            del os.environ[key]

    yield

    # 테스트 후 삭제
    for key in (TOKEN_ENV_KEY, REFRESH_TOKEN_ENV_KEY):
        if key in os.environ:
            del os.environ[key]


@pytest.fixture
def creds_path(tmp_path: Path, monkeypatch):
    """임시 credentials.json 경로로 CREDENTIALS_PATH를 교체"""
    fake_path = tmp_path / ".claude" / ".credentials.json"
    import soul_server.api.claude_auth.token_store as ts
    monkeypatch.setattr(ts, "CREDENTIALS_PATH", fake_path)
    return fake_path


class TestSaveOAuthToken:
    """save_oauth_token 테스트 (setup-token 방식)"""

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
        assert "OTHER_VAR=value" in content
        assert f"{TOKEN_ENV_KEY}=sk-ant-oat01-new" in content
        assert "# Claude Code OAuth Token (auto-generated)" in content

    def test_save_does_not_write_refresh_token(self, env_path: Path):
        """save_oauth_token은 refresh_token을 저장하지 않는다 (PKCE는 credentials.json 사용)"""
        save_oauth_token("sk-ant-oat01-access", env_path=env_path)

        assert REFRESH_TOKEN_ENV_KEY not in os.environ
        content = env_path.read_text()
        assert REFRESH_TOKEN_ENV_KEY not in content


class TestDeleteOAuthToken:
    """delete_oauth_token 테스트"""

    def test_delete_from_env_and_file(self, env_path: Path, creds_path: Path):
        """환경변수와 파일 모두에서 삭제"""
        os.environ[TOKEN_ENV_KEY] = "sk-ant-oat01-test"
        env_path.write_text(f"{TOKEN_ENV_KEY}=sk-ant-oat01-test\nOTHER_VAR=value\n")

        result = delete_oauth_token(env_path=env_path)

        assert result is True
        assert TOKEN_ENV_KEY not in os.environ

        content = env_path.read_text()
        assert TOKEN_ENV_KEY not in content
        assert "OTHER_VAR=value" in content

    def test_delete_env_only(self, env_path: Path, creds_path: Path):
        """환경변수만 있을 때"""
        os.environ[TOKEN_ENV_KEY] = "sk-ant-oat01-test"
        # 파일 없음

        result = delete_oauth_token(env_path=env_path)

        assert result is True
        assert TOKEN_ENV_KEY not in os.environ

    def test_delete_file_only(self, env_path: Path, creds_path: Path):
        """파일에만 있을 때"""
        env_path.write_text(f"{TOKEN_ENV_KEY}=sk-ant-oat01-test\n")
        # 환경변수 없음

        result = delete_oauth_token(env_path=env_path)

        assert result is True
        content = env_path.read_text()
        assert TOKEN_ENV_KEY not in content

    def test_delete_not_found(self, env_path: Path, creds_path: Path):
        """토큰이 없을 때"""
        env_path.write_text("OTHER_VAR=value\n")

        result = delete_oauth_token(env_path=env_path)

        assert result is False

    def test_delete_cleans_empty_lines(self, env_path: Path, creds_path: Path):
        """삭제 후 빈 줄 정리"""
        env_path.write_text(f"VAR1=a\n{TOKEN_ENV_KEY}=token\nVAR2=b\n")

        delete_oauth_token(env_path=env_path)

        content = env_path.read_text()
        # 연속된 빈 줄이 없어야 함
        assert "\n\n\n" not in content

    def test_delete_cleans_legacy_refresh_env(self, env_path: Path, creds_path: Path):
        """이전 잘못된 구현이 남긴 REFRESH_TOKEN 환경변수도 정리"""
        os.environ[TOKEN_ENV_KEY] = "sk-ant-oat01-test"
        os.environ[REFRESH_TOKEN_ENV_KEY] = "refresh-abc"
        env_path.write_text(
            f"{TOKEN_ENV_KEY}=sk-ant-oat01-test\n"
            f"{REFRESH_TOKEN_ENV_KEY}=refresh-abc\n"
            "OTHER_VAR=value\n"
        )

        result = delete_oauth_token(env_path=env_path)

        assert result is True
        assert TOKEN_ENV_KEY not in os.environ
        assert REFRESH_TOKEN_ENV_KEY not in os.environ

        content = env_path.read_text()
        assert TOKEN_ENV_KEY not in content
        assert REFRESH_TOKEN_ENV_KEY not in content
        assert "OTHER_VAR=value" in content

    def test_delete_also_removes_credentials_json(self, env_path: Path, creds_path: Path):
        """delete_oauth_token이 credentials.json도 함께 삭제"""
        os.environ[TOKEN_ENV_KEY] = "sk-ant-oat01-test"
        env_path.write_text(f"{TOKEN_ENV_KEY}=sk-ant-oat01-test\n")

        # credentials.json 생성
        creds_path.parent.mkdir(parents=True, exist_ok=True)
        creds_path.write_text(json.dumps({
            "claudeAiOauth": {"accessToken": "sk-ant-oat01-test", "refreshToken": "rt-xxx"}
        }))

        delete_oauth_token(env_path=env_path)

        # credentials.json에서 claudeAiOauth가 삭제됨
        remaining = json.loads(creds_path.read_text())
        assert "claudeAiOauth" not in remaining


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


class TestSaveCredentialsJson:
    """save_credentials_json 테스트 (PKCE OAuth 방식)"""

    def test_save_creates_file(self, creds_path: Path):
        """credentials.json 파일 생성"""
        save_credentials_json("sk-ant-oat01-access", "sk-ant-ort01-refresh")

        assert creds_path.exists()
        data = json.loads(creds_path.read_text())
        assert data["claudeAiOauth"]["accessToken"] == "sk-ant-oat01-access"
        assert data["claudeAiOauth"]["refreshToken"] == "sk-ant-ort01-refresh"

    def test_save_with_expires_in(self, creds_path: Path):
        """expires_in이 있으면 expiresAt(unix ms) 계산"""
        save_credentials_json(
            "sk-ant-oat01-access", "sk-ant-ort01-refresh",
            expires_in=28800,
        )

        data = json.loads(creds_path.read_text())
        oauth = data["claudeAiOauth"]
        assert "expiresAt" in oauth
        # expiresAt는 현재 시간 + 28800초의 밀리초 값
        assert isinstance(oauth["expiresAt"], int)
        assert oauth["expiresAt"] > 0

    def test_save_with_scope(self, creds_path: Path):
        """scope 문자열을 배열로 변환"""
        save_credentials_json(
            "sk-ant-oat01-access", "sk-ant-ort01-refresh",
            scope="user:inference user:profile",
        )

        data = json.loads(creds_path.read_text())
        assert data["claudeAiOauth"]["scopes"] == ["user:inference", "user:profile"]

    def test_save_preserves_other_keys(self, creds_path: Path):
        """기존 credentials.json의 다른 키를 보존"""
        creds_path.parent.mkdir(parents=True, exist_ok=True)
        creds_path.write_text(json.dumps({"someOtherAuth": {"key": "val"}}))

        save_credentials_json("sk-ant-oat01-access", "sk-ant-ort01-refresh")

        data = json.loads(creds_path.read_text())
        assert data["someOtherAuth"] == {"key": "val"}
        assert "claudeAiOauth" in data

    def test_save_overwrites_existing_oauth(self, creds_path: Path):
        """기존 claudeAiOauth를 덮어씀"""
        creds_path.parent.mkdir(parents=True, exist_ok=True)
        creds_path.write_text(json.dumps({
            "claudeAiOauth": {"accessToken": "old", "refreshToken": "old-rt"}
        }))

        save_credentials_json("sk-ant-oat01-new", "sk-ant-ort01-new-rt")

        data = json.loads(creds_path.read_text())
        assert data["claudeAiOauth"]["accessToken"] == "sk-ant-oat01-new"
        assert data["claudeAiOauth"]["refreshToken"] == "sk-ant-ort01-new-rt"

    def test_save_without_optional_fields(self, creds_path: Path):
        """expires_in, scope 없으면 해당 필드 생략"""
        save_credentials_json("sk-ant-oat01-access", "sk-ant-ort01-refresh")

        data = json.loads(creds_path.read_text())
        oauth = data["claudeAiOauth"]
        assert "expiresAt" not in oauth
        assert "scopes" not in oauth

    def test_save_does_not_set_env_var(self, creds_path: Path):
        """credentials.json 저장은 환경변수를 설정하지 않는다"""
        save_credentials_json("sk-ant-oat01-access", "sk-ant-ort01-refresh")

        assert TOKEN_ENV_KEY not in os.environ
        assert REFRESH_TOKEN_ENV_KEY not in os.environ


class TestDeleteCredentialsJson:
    """delete_credentials_json 테스트"""

    def test_delete_existing(self, creds_path: Path):
        """claudeAiOauth 섹션 삭제"""
        creds_path.parent.mkdir(parents=True, exist_ok=True)
        creds_path.write_text(json.dumps({
            "claudeAiOauth": {"accessToken": "test", "refreshToken": "rt"},
            "other": "data",
        }))

        result = delete_credentials_json()

        assert result is True
        data = json.loads(creds_path.read_text())
        assert "claudeAiOauth" not in data
        assert data["other"] == "data"

    def test_delete_not_exists(self, creds_path: Path):
        """claudeAiOauth가 없으면 False"""
        creds_path.parent.mkdir(parents=True, exist_ok=True)
        creds_path.write_text(json.dumps({"other": "data"}))

        result = delete_credentials_json()

        assert result is False

    def test_delete_no_file(self, creds_path: Path):
        """파일이 없으면 False"""
        result = delete_credentials_json()

        assert result is False


class TestLoadProfiles:
    """load_profiles 테스트"""

    def test_load_profiles_file_missing(self, tmp_path: Path):
        """파일이 없으면 빈 dict 반환"""
        profiles_path = tmp_path / "oauth_token.yaml"
        assert not profiles_path.exists()

        result = load_profiles(profiles_path)

        assert result == {}

    def test_load_profiles_valid(self, tmp_path: Path):
        """정상 yaml 파싱"""
        profiles_path = tmp_path / "oauth_token.yaml"
        profiles_path.write_text(
            "eias@gmail.com:\n"
            "  token: sk-ant-oat01-aaaa\n"
            "other@account.com:\n"
            "  token: sk-ant-oat01-bbbb\n",
            encoding="utf-8",
        )

        result = load_profiles(profiles_path)

        assert result == {
            "eias@gmail.com": "sk-ant-oat01-aaaa",
            "other@account.com": "sk-ant-oat01-bbbb",
        }

    def test_load_profiles_empty_file(self, tmp_path: Path):
        """빈 파일이면 빈 dict 반환"""
        profiles_path = tmp_path / "oauth_token.yaml"
        profiles_path.write_text("", encoding="utf-8")

        result = load_profiles(profiles_path)

        assert result == {}

    def test_load_profiles_malformed_entry_skipped(self, tmp_path: Path):
        """token 키가 없는 항목은 무시"""
        profiles_path = tmp_path / "oauth_token.yaml"
        profiles_path.write_text(
            "valid@gmail.com:\n"
            "  token: sk-ant-oat01-aaaa\n"
            "invalid@gmail.com:\n"
            "  other_key: something\n",
            encoding="utf-8",
        )

        result = load_profiles(profiles_path)

        assert result == {"valid@gmail.com": "sk-ant-oat01-aaaa"}


class TestGetCurrentProfileName:
    """get_current_profile_name 테스트"""

    def test_get_current_profile_name_match(self):
        """토큰 일치 시 프로필명 반환"""
        os.environ[TOKEN_ENV_KEY] = "sk-ant-oat01-aaaa"
        profiles = {
            "eias@gmail.com": "sk-ant-oat01-aaaa",
            "other@account.com": "sk-ant-oat01-bbbb",
        }

        result = get_current_profile_name(profiles)

        assert result == "eias@gmail.com"

    def test_get_current_profile_name_no_match(self):
        """불일치 시 None 반환"""
        os.environ[TOKEN_ENV_KEY] = "sk-ant-oat01-cccc"
        profiles = {
            "eias@gmail.com": "sk-ant-oat01-aaaa",
            "other@account.com": "sk-ant-oat01-bbbb",
        }

        result = get_current_profile_name(profiles)

        assert result is None

    def test_get_current_profile_name_no_env_token(self):
        """환경변수 토큰 없으면 None 반환"""
        # cleanup_env fixture가 TOKEN_ENV_KEY를 삭제함
        profiles = {"eias@gmail.com": "sk-ant-oat01-aaaa"}

        result = get_current_profile_name(profiles)

        assert result is None
