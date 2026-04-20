"""CORS 설정과 프로덕션 가드 테스트.

- field_validator 단위 테스트: CSV / JSON / 빈 문자열 3가지 파싱 경로.
- 통합 테스트: OPTIONS preflight 허용/비허용 origin 검증.
- 프로덕션 가드: ENVIRONMENT=production + 빈 CORS → RuntimeError.
"""

import pytest
from httpx import ASGITransport, AsyncClient

from soulstream_server.config import Settings, get_settings
from soulstream_server.main import _check_production_cors


# === field_validator 단위 테스트 ===

def test_parse_cors_csv():
    """CSV 문자열을 list로 분해한다."""
    s = Settings(
        host="0.0.0.0",
        port=5200,
        database_url="postgresql://test:test@localhost:5432/test",
        environment="development",
        cors_allowed_origins="https://a,https://b",
    )
    assert s.cors_allowed_origins == ["https://a", "https://b"]


def test_parse_cors_json():
    """JSON 배열 문자열을 list로 파싱한다."""
    s = Settings(
        host="0.0.0.0",
        port=5200,
        database_url="postgresql://test:test@localhost:5432/test",
        environment="development",
        cors_allowed_origins='["https://a","https://b"]',
    )
    assert s.cors_allowed_origins == ["https://a", "https://b"]


def test_parse_cors_empty():
    """빈 문자열은 빈 리스트로 처리한다."""
    s = Settings(
        host="0.0.0.0",
        port=5200,
        database_url="postgresql://test:test@localhost:5432/test",
        environment="development",
        cors_allowed_origins="",
    )
    assert s.cors_allowed_origins == []


def test_parse_cors_csv_strips_whitespace():
    """CSV 항목 주변 공백을 strip하고 빈 항목은 제거한다."""
    s = Settings(
        host="0.0.0.0",
        port=5200,
        database_url="postgresql://test:test@localhost:5432/test",
        environment="development",
        cors_allowed_origins=" https://a , https://b , ",
    )
    assert s.cors_allowed_origins == ["https://a", "https://b"]


# === 통합 테스트 (CORS preflight) ===

@pytest.mark.asyncio
async def test_cors_allowed_origin(test_app):
    """conftest에서 설정한 http://testserver가 허용된다.

    preflight OPTIONS는 인증 Depends 실행 전 CORSMiddleware 단에서 처리되므로
    Authorization 헤더 없이도 통과해야 한다.
    """
    transport = ASGITransport(app=test_app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.options(
            "/api/nodes",
            headers={
                "Origin": "http://testserver",
                "Access-Control-Request-Method": "GET",
            },
        )
    assert resp.headers.get("access-control-allow-origin") == "http://testserver"


@pytest.mark.asyncio
async def test_cors_disallowed_origin(test_app):
    """허용되지 않은 origin은 Access-Control-Allow-Origin 헤더를 받지 못한다."""
    transport = ASGITransport(app=test_app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.options(
            "/api/nodes",
            headers={
                "Origin": "http://evil.example.com",
                "Access-Control-Request-Method": "GET",
            },
        )
    assert "access-control-allow-origin" not in resp.headers


# === 프로덕션 가드 테스트 ===

def test_production_guard_raises_when_origins_empty(monkeypatch):
    """ENVIRONMENT=production + CORS_ALLOWED_ORIGINS 빈 경우 _check_production_cors가 실패한다."""
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "")
    # 다른 필수 env는 conftest.pytest_configure에서 이미 설정됨.
    get_settings.cache_clear()
    try:
        settings = get_settings()
        assert settings.is_production is True
        assert settings.cors_allowed_origins == []
        with pytest.raises(RuntimeError, match="CORS_ALLOWED_ORIGINS must be set"):
            _check_production_cors(settings)
    finally:
        # reset_settings_cache autouse가 세션 종료 시 캐시를 비우지만,
        # 다음 테스트가 즉시 정상 환경을 보도록 명시적으로 비운다.
        get_settings.cache_clear()


def test_production_guard_ok_when_origins_set(monkeypatch):
    """ENVIRONMENT=production + CORS_ALLOWED_ORIGINS 있는 경우 가드를 통과한다."""
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://a.example.com")
    get_settings.cache_clear()
    try:
        settings = get_settings()
        assert settings.is_production is True
        assert settings.cors_allowed_origins == ["https://a.example.com"]
        # 예외 없이 반환되어야 함
        _check_production_cors(settings)
    finally:
        get_settings.cache_clear()
