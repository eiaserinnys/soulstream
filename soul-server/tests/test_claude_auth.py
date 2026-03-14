"""
Claude OAuth 토큰 API 테스트

POST /auth/claude/token - 토큰 설정
DELETE /auth/claude/token - 토큰 삭제

NOTE: 이 테스트는 soul_server.api 패키지를 import하지 않고
개별 모듈을 직접 import합니다 (cogito 의존성 회피).
"""

import os
import sys
import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock

# token_store 모듈을 직접 import하기 위해 src를 path에 추가
_src_path = Path(__file__).parent.parent / "src"
if str(_src_path) not in sys.path:
    sys.path.insert(0, str(_src_path))

# 개별 모듈 직접 import (패키지 __init__.py 우회)
import importlib.util


def _import_module_directly(module_path: Path, module_name: str):
    """__init__.py를 거치지 않고 모듈을 직접 import"""
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


# token_store 모듈 직접 로드
_token_store_path = _src_path / "soul_server" / "api" / "claude_auth" / "token_store.py"
token_store = _import_module_directly(_token_store_path, "token_store_test")

is_valid_token = token_store.is_valid_token
save_oauth_token = token_store.save_oauth_token
delete_oauth_token = token_store.delete_oauth_token
get_env_path = token_store.get_env_path


# === token_store 유닛 테스트 ===


class TestIsValidToken:
    """토큰 형식 검증 테스트"""

    def test_valid_token(self):
        """유효한 토큰 형식"""
        assert is_valid_token("sk-ant-oat01-abc123") is True
        assert is_valid_token("sk-ant-oat01-ABC-xyz_456") is True
        assert is_valid_token("sk-ant-oat01-a1b2c3d4e5f6g7h8i9j0") is True

    def test_invalid_token_empty(self):
        """빈 토큰"""
        assert is_valid_token("") is False
        assert is_valid_token("   ") is False

    def test_invalid_token_wrong_prefix(self):
        """잘못된 접두사"""
        assert is_valid_token("sk-ant-oat02-abc123") is False
        assert is_valid_token("sk-abc123") is False
        assert is_valid_token("abc123") is False

    def test_invalid_token_special_chars(self):
        """허용되지 않는 특수문자"""
        assert is_valid_token("sk-ant-oat01-abc@123") is False
        assert is_valid_token("sk-ant-oat01-abc 123") is False
        assert is_valid_token("sk-ant-oat01-abc#123") is False

    def test_token_with_whitespace_trimmed(self):
        """앞뒤 공백은 트림 후 검증"""
        assert is_valid_token("  sk-ant-oat01-abc123  ") is True


class TestSaveOAuthToken:
    """토큰 저장 테스트"""

    def test_save_to_new_file(self, tmp_path: Path):
        """새 .env 파일에 저장"""
        env_path = tmp_path / ".env"
        token = "sk-ant-oat01-test123"

        save_oauth_token(token, env_path)

        # 환경변수 확인
        assert os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") == token

        # 파일 확인
        content = env_path.read_text()
        assert f"CLAUDE_CODE_OAUTH_TOKEN={token}" in content
        assert "# Claude Code OAuth Token (auto-generated)" in content

    def test_save_to_existing_file(self, tmp_path: Path):
        """기존 .env 파일에 추가"""
        env_path = tmp_path / ".env"
        env_path.write_text("EXISTING_VAR=value\n")
        token = "sk-ant-oat01-test456"

        save_oauth_token(token, env_path)

        content = env_path.read_text()
        assert "EXISTING_VAR=value" in content
        assert f"CLAUDE_CODE_OAUTH_TOKEN={token}" in content

    def test_update_existing_token(self, tmp_path: Path):
        """기존 토큰 업데이트"""
        env_path = tmp_path / ".env"
        old_token = "sk-ant-oat01-old"
        new_token = "sk-ant-oat01-new"
        env_path.write_text(f"CLAUDE_CODE_OAUTH_TOKEN={old_token}\n")

        save_oauth_token(new_token, env_path)

        content = env_path.read_text()
        assert old_token not in content
        assert f"CLAUDE_CODE_OAUTH_TOKEN={new_token}" in content
        # 중복 라인이 없어야 함
        assert content.count("CLAUDE_CODE_OAUTH_TOKEN=") == 1

    def test_save_creates_parent_directories(self, tmp_path: Path):
        """부모 디렉토리 자동 생성"""
        env_path = tmp_path / "nested" / "dir" / ".env"
        token = "sk-ant-oat01-nested"

        save_oauth_token(token, env_path)

        assert env_path.exists()
        assert f"CLAUDE_CODE_OAUTH_TOKEN={token}" in env_path.read_text()

    def test_save_trims_whitespace(self, tmp_path: Path):
        """토큰 앞뒤 공백 제거"""
        env_path = tmp_path / ".env"
        token = "  sk-ant-oat01-trimmed  "

        save_oauth_token(token, env_path)

        content = env_path.read_text()
        assert "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-trimmed" in content
        assert os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") == "sk-ant-oat01-trimmed"


class TestDeleteOAuthToken:
    """토큰 삭제 테스트"""

    def test_delete_existing_token(self, tmp_path: Path):
        """기존 토큰 삭제"""
        env_path = tmp_path / ".env"
        token = "sk-ant-oat01-todelete"
        env_path.write_text(
            f"SOME_VAR=value\n"
            f"# Claude Code OAuth Token (auto-generated)\n"
            f"CLAUDE_CODE_OAUTH_TOKEN={token}\n"
        )
        os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = token

        result = delete_oauth_token(env_path)

        assert result is True
        assert "CLAUDE_CODE_OAUTH_TOKEN" not in os.environ
        content = env_path.read_text()
        assert "CLAUDE_CODE_OAUTH_TOKEN" not in content
        assert "# Claude Code OAuth Token" not in content
        assert "SOME_VAR=value" in content

    def test_delete_nonexistent_token(self, tmp_path: Path):
        """존재하지 않는 토큰 삭제 시도"""
        env_path = tmp_path / ".env"
        env_path.write_text("OTHER_VAR=value\n")
        # 환경변수에도 없음
        if "CLAUDE_CODE_OAUTH_TOKEN" in os.environ:
            del os.environ["CLAUDE_CODE_OAUTH_TOKEN"]

        result = delete_oauth_token(env_path)

        assert result is False
        content = env_path.read_text()
        assert "OTHER_VAR=value" in content

    def test_delete_from_env_only(self, tmp_path: Path):
        """환경변수에만 있는 토큰 삭제"""
        env_path = tmp_path / ".env"
        env_path.write_text("OTHER_VAR=value\n")
        os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = "sk-ant-oat01-envonly"

        result = delete_oauth_token(env_path)

        assert result is True
        assert "CLAUDE_CODE_OAUTH_TOKEN" not in os.environ

    def test_delete_from_file_only(self, tmp_path: Path):
        """파일에만 있는 토큰 삭제"""
        env_path = tmp_path / ".env"
        env_path.write_text("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fileonly\n")
        # 환경변수에는 없음
        if "CLAUDE_CODE_OAUTH_TOKEN" in os.environ:
            del os.environ["CLAUDE_CODE_OAUTH_TOKEN"]

        result = delete_oauth_token(env_path)

        assert result is True
        assert "CLAUDE_CODE_OAUTH_TOKEN" not in env_path.read_text()

    def test_delete_nonexistent_file(self, tmp_path: Path):
        """존재하지 않는 .env 파일"""
        env_path = tmp_path / "nonexistent" / ".env"
        if "CLAUDE_CODE_OAUTH_TOKEN" in os.environ:
            del os.environ["CLAUDE_CODE_OAUTH_TOKEN"]

        result = delete_oauth_token(env_path)

        assert result is False


class TestGetEnvPath:
    """get_env_path 테스트"""

    def test_returns_cwd_env(self):
        """CWD/.env 반환"""
        result = get_env_path()
        assert result == Path.cwd() / ".env"


# === API 엔드포인트 테스트 ===
# NOTE: router.py는 soul_server.api.auth를 import하므로,
# 전체 soul_server.api를 로드하게 됩니다.
# 따라서 router 테스트는 통합 테스트 환경(cogito 설치됨)에서만 실행합니다.

# 아래 테스트는 cogito가 설치된 환경에서만 실행됩니다.
try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from soul_server.api.claude_auth.router import create_claude_auth_router

    _ROUTER_TESTS_AVAILABLE = True
except ImportError:
    _ROUTER_TESTS_AVAILABLE = False


@pytest.fixture
def test_env_path(tmp_path: Path) -> Path:
    """테스트용 .env 파일 경로"""
    return tmp_path / ".env"


@pytest.fixture
def client(test_env_path: Path):
    """테스트 클라이언트"""
    if not _ROUTER_TESTS_AVAILABLE:
        pytest.skip("Router tests require full soul_server environment")

    app = FastAPI()
    router = create_claude_auth_router(env_path=test_env_path)
    app.include_router(router, prefix="/auth/claude")
    return TestClient(app)


@pytest.fixture
def auth_headers() -> dict:
    """인증 헤더"""
    return {"Authorization": "Bearer test-bearer-token-for-testing"}


@pytest.mark.skipif(not _ROUTER_TESTS_AVAILABLE, reason="Router tests require cogito")
class TestSetTokenEndpoint:
    """POST /auth/claude/token 테스트"""

    def test_set_valid_token(self, client, auth_headers: dict, test_env_path: Path):
        """유효한 토큰 설정"""
        response = client.post(
            "/auth/claude/token",
            json={"token": "sk-ant-oat01-valid123"},
            headers=auth_headers,
        )

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert data["message"] == "토큰이 설정되었습니다."

        # 파일에 저장되었는지 확인
        assert test_env_path.exists()
        assert "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-valid123" in test_env_path.read_text()

    def test_set_invalid_token(self, client, auth_headers: dict):
        """유효하지 않은 토큰 형식"""
        response = client.post(
            "/auth/claude/token",
            json={"token": "invalid-token-format"},
            headers=auth_headers,
        )

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is False
        assert data["error"] == "유효하지 않은 토큰 형식입니다."

    def test_set_empty_token(self, client, auth_headers: dict):
        """빈 토큰"""
        response = client.post(
            "/auth/claude/token",
            json={"token": ""},
            headers=auth_headers,
        )

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is False
        assert "유효하지 않은 토큰 형식" in data["error"]

    def test_set_token_unauthorized(self, client):
        """인증 없이 요청"""
        response = client.post(
            "/auth/claude/token",
            json={"token": "sk-ant-oat01-valid"},
        )

        # 인증 실패는 401
        assert response.status_code == 401


@pytest.mark.skipif(not _ROUTER_TESTS_AVAILABLE, reason="Router tests require cogito")
class TestDeleteTokenEndpoint:
    """DELETE /auth/claude/token 테스트"""

    def test_delete_existing_token(
        self, client, auth_headers: dict, test_env_path: Path
    ):
        """존재하는 토큰 삭제"""
        # 먼저 토큰 설정
        test_env_path.write_text("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-todelete\n")
        os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = "sk-ant-oat01-todelete"

        response = client.delete("/auth/claude/token", headers=auth_headers)

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert data["message"] == "토큰이 삭제되었습니다."

        # 파일에서 삭제되었는지 확인
        assert "CLAUDE_CODE_OAUTH_TOKEN" not in test_env_path.read_text()

    def test_delete_nonexistent_token(
        self, client, auth_headers: dict, test_env_path: Path
    ):
        """존재하지 않는 토큰 삭제"""
        test_env_path.write_text("OTHER_VAR=value\n")
        if "CLAUDE_CODE_OAUTH_TOKEN" in os.environ:
            del os.environ["CLAUDE_CODE_OAUTH_TOKEN"]

        response = client.delete("/auth/claude/token", headers=auth_headers)

        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert data["message"] == "삭제할 토큰이 없습니다."

    def test_delete_token_unauthorized(self, client):
        """인증 없이 요청"""
        response = client.delete("/auth/claude/token")

        assert response.status_code == 401


@pytest.mark.skipif(not _ROUTER_TESTS_AVAILABLE, reason="Router tests require cogito")
class TestTokenPersistence:
    """토큰 저장/삭제 후 영속성 테스트"""

    def test_token_persists_after_save(
        self, client, auth_headers: dict, test_env_path: Path
    ):
        """저장 후 환경변수에 반영"""
        token = "sk-ant-oat01-persist"

        response = client.post(
            "/auth/claude/token",
            json={"token": token},
            headers=auth_headers,
        )

        assert response.status_code == 200
        assert os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") == token

    def test_update_replaces_old_token(
        self, client, auth_headers: dict, test_env_path: Path
    ):
        """기존 토큰 업데이트"""
        old_token = "sk-ant-oat01-old"
        new_token = "sk-ant-oat01-new"

        # 첫 번째 토큰 설정
        client.post(
            "/auth/claude/token",
            json={"token": old_token},
            headers=auth_headers,
        )

        # 두 번째 토큰으로 업데이트
        response = client.post(
            "/auth/claude/token",
            json={"token": new_token},
            headers=auth_headers,
        )

        assert response.status_code == 200
        assert os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") == new_token

        content = test_env_path.read_text()
        assert old_token not in content
        assert new_token in content
        assert content.count("CLAUDE_CODE_OAUTH_TOKEN=") == 1
