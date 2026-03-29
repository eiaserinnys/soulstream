"""
pytest 전역 설정 및 fixture

테스트 환경을 올바르게 구성합니다:
1. ENVIRONMENT를 development로 설정 (프로덕션 모드 방지)
2. WORKSPACE_DIR 설정 (필수 환경변수)
3. get_settings 캐시 초기화 (환경변수 변경 반영)
4. 인증이 필요한 테스트를 위한 토큰 및 헤더 fixture 제공
5. cogito/fastmcp 모듈 모킹 (의존성 없이 테스트 가능)
"""

import importlib.util
import os
import sys
import pytest
import pytest_asyncio
from pathlib import Path
from unittest.mock import MagicMock


# === 테스트 환경 상수 ===
TEST_AUTH_TOKEN = "test-bearer-token-for-testing"


def pytest_configure(config):
    """pytest 시작 시 테스트 환경 변수 설정.

    이 함수는 테스트 수집 전에 호출되므로,
    모든 모듈 임포트 전에 환경 변수가 설정됩니다.
    """
    # venv의 .pth 파일(soulstream_runtime 경로)보다 로컬 소스를 우선하도록 sys.path 앞에 삽입
    # 이렇게 하지 않으면 런타임의 soul_server가 로드되어 잘못된 모듈이 테스트됨
    local_src = Path(__file__).parent.parent / "src"
    if str(local_src) not in sys.path:
        sys.path.insert(0, str(local_src))

    # cogito 및 fastmcp 모듈 모킹 (패키지가 설치되지 않은 환경에서 테스트 가능하게)
    # soul_server.cogito 모듈이 cogito와 fastmcp를 임포트하므로, 임포트 전에 모킹 필요
    if importlib.util.find_spec("cogito") is None:
        mock_cogito = MagicMock()
        mock_cogito.Reflector = MagicMock
        sys.modules["cogito"] = mock_cogito
        sys.modules["cogito.endpoint"] = MagicMock()
        sys.modules["cogito.manifest"] = MagicMock()  # load_manifest 모킹

    if importlib.util.find_spec("fastmcp") is None:
        mock_fastmcp = MagicMock()
        # FastMCP 클래스를 lambda로 설정: MagicMock 클래스를 직접 할당하면
        # FastMCP("soulstream-cogito") 호출 시 spec="soulstream-cogito"로 해석되어
        # @cogito_mcp.tool() 데코레이터가 AttributeError를 일으킨다.
        mock_fastmcp.FastMCP = lambda *args, **kwargs: MagicMock()
        sys.modules["fastmcp"] = mock_fastmcp

    # 테스트 환경으로 설정
    os.environ["ENVIRONMENT"] = "development"

    # 필수 환경변수 설정 (임시 경로 사용)
    if "WORKSPACE_DIR" not in os.environ:
        os.environ["WORKSPACE_DIR"] = "/tmp/soul-server-test-workspace"

    # 필수 환경변수 설정 (테스트용 더미 값)
    if "SOULSTREAM_NODE_ID" not in os.environ:
        os.environ["SOULSTREAM_NODE_ID"] = "test-node"
    if "DATABASE_URL" not in os.environ:
        os.environ["DATABASE_URL"] = "postgresql://test:test@localhost:5432/test"

    # 테스트용 인증 토큰 설정
    os.environ["AUTH_BEARER_TOKEN"] = TEST_AUTH_TOKEN

    # AGENTS_CONFIG_FILE — 미설정 시 degraded mode로 동작
    if "AGENTS_CONFIG_FILE" not in os.environ:
        os.environ["AGENTS_CONFIG_FILE"] = ""  # degraded mode

    # 캐시 디렉토리 (테스트 환경에서는 /tmp 사용)
    if "SOUL_DASHBOARD_CACHE_DIR" not in os.environ:
        os.environ["SOUL_DASHBOARD_CACHE_DIR"] = "/tmp/soul-server-test-cache"


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


@pytest_asyncio.fixture
async def test_db():
    """실제 PostgreSQL DB에 연결하여 프로시저를 테스트하는 fixture.

    TEST_DATABASE_URL 환경변수가 없으면 skip한다.
    기존 mock 기반 테스트에 영향 없음.
    """
    try:
        import asyncpg
    except ImportError:
        pytest.skip("asyncpg not installed")

    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL not set")

    pool = await asyncpg.create_pool(url)
    schema_path = Path(__file__).resolve().parent.parent / "sql" / "schema.sql"
    schema_sql = schema_path.read_text(encoding="utf-8")
    await pool.execute(schema_sql)

    yield pool

    # 정리: 의존성 순서에 맞게 삭제
    await pool.execute("DELETE FROM events")
    await pool.execute("DELETE FROM sessions")
    await pool.execute("DELETE FROM folders")
    await pool.close()
