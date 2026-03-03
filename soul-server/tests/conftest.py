"""
pytest 전역 설정 및 fixture

테스트 환경을 올바르게 구성합니다:
1. ENVIRONMENT를 development로 설정 (프로덕션 모드 방지)
2. WORKSPACE_DIR 설정 (필수 환경변수)
3. get_settings 캐시 초기화 (환경변수 변경 반영)
4. 인증이 필요한 테스트를 위한 토큰 및 헤더 fixture 제공
"""

import os
import pytest
from pathlib import Path


# === 테스트 환경 상수 ===
TEST_AUTH_TOKEN = "test-bearer-token-for-testing"


def pytest_configure(config):
    """pytest 시작 시 테스트 환경 변수 설정.

    이 함수는 테스트 수집 전에 호출되므로,
    모든 모듈 임포트 전에 환경 변수가 설정됩니다.
    """
    # 테스트 환경으로 설정
    os.environ["ENVIRONMENT"] = "development"

    # 필수 환경변수 설정 (임시 경로 사용)
    if "WORKSPACE_DIR" not in os.environ:
        os.environ["WORKSPACE_DIR"] = "/tmp/soul-server-test-workspace"

    # 테스트용 인증 토큰 설정
    os.environ["AUTH_BEARER_TOKEN"] = TEST_AUTH_TOKEN


@pytest.fixture(scope="session", autouse=True)
def reset_settings_cache():
    """세션 시작 시 settings 캐시 초기화.

    lru_cache된 get_settings가 프로덕션 설정을 캐시했을 수 있으므로
    테스트 시작 전에 초기화합니다.
    """
    from soul_server.config import get_settings

    # 캐시 초기화
    get_settings.cache_clear()

    # 테스트 환경 설정이 적용되었는지 확인
    settings = get_settings()
    assert settings.environment == "development", (
        f"테스트 환경이 development가 아닙니다: {settings.environment}"
    )

    yield

    # 테스트 종료 후 캐시 정리
    get_settings.cache_clear()


@pytest.fixture
def auth_token() -> str:
    """테스트용 인증 토큰 반환."""
    return TEST_AUTH_TOKEN


@pytest.fixture
def auth_headers(auth_token: str) -> dict:
    """인증된 요청을 위한 Authorization 헤더 반환."""
    return {"Authorization": f"Bearer {auth_token}"}


@pytest.fixture
def tmp_workspace(tmp_path: Path) -> Path:
    """임시 워크스페이스 디렉토리 생성."""
    workspace = tmp_path / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    return workspace
