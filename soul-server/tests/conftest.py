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

    # soul-common도 동일하게 worktree 경로를 우선시한다.
    # (orch-server conftest와 대칭 — 신규 모듈 caller_info.py 등 워크트리 변경이
    # .test-venv install된 stale main 리포 soul_common에 가려지는 것 방지)
    local_common = Path(__file__).parent.parent.parent / "packages" / "soul-common" / "src"
    if str(local_common) not in sys.path:
        sys.path.insert(0, str(local_common))

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

    # 테스트 환경변수는 셸에 어떤 값이 있든 무조건 덮어쓴다.
    # 부모 프로세스에서 prod .env가 export된 경우 (예: 봇 프로세스 하위에서 테스트 실행)
    # `if KEY not in os.environ` 가드는 무력해지고, 테스트가 prod 설정으로 동작하게 된다.
    # 특히 DATABASE_URL이 prod로 새면 test-db-safety.md 위반이며 데이터 손실 위험이 있다.
    os.environ["ENVIRONMENT"] = "development"
    os.environ["WORKSPACE_DIR"] = "/tmp/soul-server-test-workspace"
    os.environ["SOULSTREAM_NODE_ID"] = "test-node"
    os.environ["DATABASE_URL"] = "postgresql://test:test@localhost:5432/test"
    os.environ["AUTH_BEARER_TOKEN"] = TEST_AUTH_TOKEN
    os.environ["AGENTS_CONFIG_FILE"] = ""  # degraded mode
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


def ensure_test_db_url(url: str) -> None:
    """TEST_DATABASE_URL이 프로덕션 DB를 가리키지 않음을 보장한다.

    test-db-safety.md 규칙에 따라, 테스트 DB URL은 반드시 "test"를 포함해야 한다.
    `atom_db`, `reverie`, `soulstream_db`, `soul_dashboard_db` 등 프로덕션 DB 이름이
    들어있으면 즉시 RuntimeError로 거부한다.
    """
    if "test" not in url.lower():
        raise RuntimeError(
            f"TEST_DATABASE_URL must point to a test database (name containing 'test'). "
            f"Got: {url}"
        )

    forbidden = ("atom_db", "reverie", "soulstream_db", "soul_dashboard_db", "serendipity")
    for name in forbidden:
        if name in url.lower():
            raise RuntimeError(
                f"TEST_DATABASE_URL must not reference production DB '{name}'. "
                f"Got: {url}"
            )


@pytest_asyncio.fixture
async def test_db():
    """실제 PostgreSQL DB에 연결하여 프로시저를 테스트하는 fixture.

    TEST_DATABASE_URL 환경변수가 없으면 skip한다.
    기존 mock 기반 테스트에 영향 없음.

    test-db-safety.md 규칙에 따라 프로덕션 DB URL을 감지하면 RuntimeError를 발생시킨다.
    """
    try:
        import asyncpg
    except ImportError:
        pytest.skip("asyncpg not installed")

    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL not set")

    # 프로덕션 DB 차단 가드 — test-db-safety.md
    ensure_test_db_url(url)

    pool = await asyncpg.create_pool(url)
    schema_path = Path(__file__).resolve().parent.parent / "sql" / "schema.sql"
    schema_sql = schema_path.read_text(encoding="utf-8")
    await pool.execute(schema_sql)

    yield pool

    # 정리: 의존성 순서에 맞게 삭제
    await pool.execute("DELETE FROM supervisor_events")
    await pool.execute("DELETE FROM supervisor_source_cursors")
    await pool.execute("DELETE FROM supervisor_consumers")
    await pool.execute("DELETE FROM supervisor_registry")
    await pool.execute("DELETE FROM events")
    await pool.execute("DELETE FROM sessions")
    await pool.execute("DELETE FROM folders")
    await pool.close()
