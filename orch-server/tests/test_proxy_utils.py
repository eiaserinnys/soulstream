"""orch→soul HTTP 프록시 공용 헬퍼(forward_auth_headers) 단위 테스트.

forward_auth_headers는 들어온 FastAPI Request의 Cookie/Authorization 헤더만 골라
soul-server forward 호출에 사용할 dict를 만든다. 입력에 따라 출력 dict 키가
정확히 결정되는지 4가지 조합으로 검증한다.
"""

from unittest.mock import MagicMock

from soulstream_server.api._proxy_utils import forward_auth_headers


def _make_request(headers: dict[str, str]):
    """Request의 .headers 속성만 사용하므로 MagicMock으로 대체.

    Starlette Request.headers는 case-insensitive 컨테이너이지만, 우리 코드는
    소문자 키로 .get을 호출한다. MagicMock(headers=dict)으로 충분하다.
    """
    request = MagicMock()
    # 소문자 키만 사용 (FastAPI/Starlette는 헤더를 소문자로 정규화)
    request.headers = {k.lower(): v for k, v in headers.items()}
    return request


def test_returns_empty_when_no_auth_headers():
    """둘 다 없을 때 빈 dict — 인증 비활성 환경 안전성."""
    request = _make_request({})
    assert forward_auth_headers(request) == {}


def test_returns_cookie_only():
    """Cookie만 있을 때 cookie 키 1개."""
    request = _make_request({"cookie": "soulstream_jwt=abc"})
    assert forward_auth_headers(request) == {"cookie": "soulstream_jwt=abc"}


def test_returns_authorization_only():
    """Authorization만 있을 때 authorization 키 1개."""
    request = _make_request({"authorization": "Bearer xyz"})
    assert forward_auth_headers(request) == {"authorization": "Bearer xyz"}


def test_returns_both_when_present():
    """쿠키와 Bearer 둘 다 있으면 둘 다 forward (soul-server가 쿠키 우선)."""
    request = _make_request({
        "cookie": "soulstream_jwt=abc",
        "authorization": "Bearer xyz",
    })
    result = forward_auth_headers(request)
    assert result == {
        "cookie": "soulstream_jwt=abc",
        "authorization": "Bearer xyz",
    }


def test_ignores_unrelated_headers():
    """user-agent 등 다른 헤더는 무시한다."""
    request = _make_request({
        "user-agent": "Mozilla/5.0",
        "x-forwarded-for": "1.2.3.4",
        "authorization": "Bearer t",
    })
    assert forward_auth_headers(request) == {"authorization": "Bearer t"}
