"""
test_create_session_caller_info - POST /api/sessions에서 caller_info 수집·전파 검증.

orch-server는 HTTP Request에서 IP/헤더를 수집하여 caller_info를 조립하고,
node WS 페이로드에 그대로 전달해야 한다.

검증 기준:
1. body에 caller_info가 없으면 서버가 HTTP Request에서 수집한다 (source="browser").
2. body에 caller_info가 있으면 서버 수집을 건너뛰고 body 값을 그대로 사용한다.
3. 조립된 caller_info는 node_connection.send_create_session을 거쳐 WS 페이로드의 'caller_info' 키로 전달된다.
4. (방안 B, 2026-05-07) cookie/Bearer JWT가 있으면 server가 user payload를 디코드하여
   display_name/user_id/avatar_url/email을 caller_info에 자동 첨부한다.
"""

from unittest.mock import AsyncMock

import pytest

from soul_common.auth.jwt import COOKIE_NAME, generate_token


# 테스트 격리용 JWT secret — fixture jwt_secret을 통해 settings에 주입.
# conftest에 환경변수로 박지 않는 이유: 기존 auth 테스트(test_auth.py 등)가
# jwt_secret 빈 값을 가정하므로, JWT 디코드 분기를 활성화하는 caller_info
# 테스트만 격리하여 monkeypatch한다.
_TEST_JWT_SECRET = "test-jwt-secret-for-caller-info-32b!"


@pytest.fixture
def jwt_secret(monkeypatch):
    """build_browser_caller_info의 JWT 분기를 활성화하기 위해 settings.jwt_secret을 주입.

    function-scoped이라 다른 테스트 격리 보장. 테스트가 끝나면 settings는 자동 복원.
    """
    from soulstream_server.config import get_settings
    settings = get_settings()
    monkeypatch.setattr(settings, "jwt_secret", _TEST_JWT_SECRET)
    return _TEST_JWT_SECRET


def _register_node(node_manager):
    """register a node and make ws.send_json resolve with a canned response."""
    ws = AsyncMock()
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()

    async def _register():
        node = await node_manager.register_node(ws, {"node_id": "test-node"})

        async def resolve_on_send(data):
            req_id = data.get("requestId")
            if req_id and req_id in node._pending:
                node._pending[req_id].set_result({"agentSessionId": "sess-routed"})

        ws.send_json.side_effect = resolve_on_send
        return node, ws

    return _register


def _extract_ws_payload(ws):
    """Return the dict that was sent to ws.send_json (the routed command)."""
    assert ws.send_json.await_count >= 1
    return ws.send_json.await_args_list[-1].args[0]


class TestCreateSessionCallerInfo:
    """POST /api/sessions가 caller_info를 조립·전파하는지 검증."""

    async def test_http_request_metadata_collected_when_body_missing(
        self, client, node_manager
    ):
        """body에 caller_info가 없으면 서버가 HTTP 헤더/IP에서 조립한다."""
        _, ws = await _register_node(node_manager)()

        resp = await client.post(
            "/api/sessions",
            json={"prompt": "test"},
            headers={
                "user-agent": "Mozilla/5.0 TestBrowser",
                "referer": "https://dashboard.example/",
                "x-forwarded-for": "203.0.113.7",
            },
        )
        assert resp.status_code == 201

        payload = _extract_ws_payload(ws)
        assert "caller_info" in payload
        ci = payload["caller_info"]
        assert ci["source"] == "browser"
        assert ci["user_agent"] == "Mozilla/5.0 TestBrowser"
        assert ci["referer"] == "https://dashboard.example/"
        assert ci["forwarded_for"] == "203.0.113.7"
        # ip는 ASGI transport 특성상 None 또는 testclient일 수 있음 — 키 존재만 검증
        assert "ip" in ci

    async def test_body_caller_info_preserved_as_is(self, client, node_manager):
        """body에 caller_info가 있으면 서버 수집을 덮어쓰지 않고 그대로 전달한다."""
        _, ws = await _register_node(node_manager)()

        supplied = {
            "source": "agent",
            "agent_node": "seosoyoung",
            "agent_id": "agent-1",
        }
        resp = await client.post(
            "/api/sessions",
            json={"prompt": "test", "caller_info": supplied},
            headers={"user-agent": "should-be-ignored"},
        )
        assert resp.status_code == 201

        payload = _extract_ws_payload(ws)
        assert payload["caller_info"] == supplied
        # HTTP Request 수집이 덮어쓰지 않았는지 확인
        assert payload["caller_info"].get("source") == "agent"
        assert "user_agent" not in payload["caller_info"]
        assert "parent_session_id" not in payload["caller_info"]

    async def test_caller_info_always_present_in_ws_payload(
        self, client, node_manager
    ):
        """헤더가 하나도 없어도 caller_info 키는 WS 페이로드에 항상 존재한다 (source='browser')."""
        _, ws = await _register_node(node_manager)()

        resp = await client.post("/api/sessions", json={"prompt": "test"})
        assert resp.status_code == 201

        payload = _extract_ws_payload(ws)
        assert "caller_info" in payload
        assert payload["caller_info"]["source"] == "browser"


class TestCreateSessionCallerInfoJwtAutoFill:
    """방안 B (2026-05-07): cookie/Bearer JWT가 있으면 caller_info에 user 정보 자동 첨부.

    JWT payload는 {sub=email, email, name, picture, exp} 구조 (jwt.py:31-38).
    통합 스키마 v1: top-level display_name/user_id/avatar_url/email 4 필드.
    user_id=email (Google 진짜 sub 미보유 — Plan C 보고 반영).
    """

    async def test_jwt_cookie_populates_caller_info_when_body_missing(
        self, client, node_manager, jwt_secret):
        """body.caller_info 없고 cookie JWT 있으면 display_name/user_id/avatar_url/email 자동 첨부."""
        _, ws = await _register_node(node_manager)()
        token = generate_token(
            {
                "email": "user@example.com",
                "name": "서소영",
                "picture": "https://lh3.googleusercontent.com/avatar.png",
            },
            jwt_secret,
        )
        resp = await client.post(
            "/api/sessions",
            json={"prompt": "test"},
            cookies={COOKIE_NAME: token},
        )
        assert resp.status_code == 201

        ci = _extract_ws_payload(ws)["caller_info"]
        assert ci["source"] == "browser"
        assert ci["display_name"] == "서소영"
        assert ci["user_id"] == "user@example.com"
        assert ci["avatar_url"] == "https://lh3.googleusercontent.com/avatar.png"
        assert ci["email"] == "user@example.com"
        # base 메타도 그대로 (HTTP 메타와 JWT 정보가 함께 존재)
        assert "ip" in ci
        assert "user_agent" in ci

    async def test_jwt_bearer_header_also_populates(self, client, node_manager, jwt_secret):
        """Authorization Bearer 헤더로도 동일하게 user 정보가 채워진다."""
        _, ws = await _register_node(node_manager)()
        token = generate_token(
            {"email": "alice@example.com", "name": "Alice", "picture": "https://x/p"},
            jwt_secret,
        )
        # 기본 fixture가 Authorization 헤더를 이미 설정하므로 명시적 오버라이드
        resp = await client.post(
            "/api/sessions",
            json={"prompt": "test"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 201

        ci = _extract_ws_payload(ws)["caller_info"]
        assert ci["display_name"] == "Alice"
        assert ci["user_id"] == "alice@example.com"

    async def test_jwt_cookie_ignored_when_body_caller_info_present(
        self, client, node_manager, jwt_secret):
        """body.caller_info가 있으면 JWT 자동 첨부는 발동하지 않는다 (기존 우선순위 보존)."""
        _, ws = await _register_node(node_manager)()
        token = generate_token(
            {"email": "should-not@example.com", "name": "Should Not"},
            jwt_secret,
        )
        supplied = {"source": "agent", "agent_node": "n1", "agent_id": "a1"}
        resp = await client.post(
            "/api/sessions",
            json={"prompt": "test", "caller_info": supplied},
            cookies={COOKIE_NAME: token},
        )
        assert resp.status_code == 201

        ci = _extract_ws_payload(ws)["caller_info"]
        # body 값 그대로 — JWT 디코드 결과 미포함
        assert ci == supplied
        assert "display_name" not in ci
        assert "user_id" not in ci

    async def test_jwt_decode_failure_falls_back_to_base(
        self, client, node_manager, jwt_secret):
        """위조/만료 JWT는 verify_token이 None을 반환하여 base caller_info(IP/UA)만 남는다."""
        _, ws = await _register_node(node_manager)()
        # 잘못된 secret으로 서명 → 본 서버에서 verify 실패
        bad_token = generate_token({"email": "x@y.z", "name": "x"}, "wrong-secret")
        resp = await client.post(
            "/api/sessions",
            json={"prompt": "test"},
            cookies={COOKIE_NAME: bad_token},
            headers={"user-agent": "TestUA"},
        )
        assert resp.status_code == 201

        ci = _extract_ws_payload(ws)["caller_info"]
        assert ci["source"] == "browser"
        assert ci["user_agent"] == "TestUA"
        # JWT 디코드 실패 → 신원 필드 없음 (graceful)
        assert "display_name" not in ci
        assert "user_id" not in ci
        assert "avatar_url" not in ci
        assert "email" not in ci

    async def test_jwt_partial_fields_graceful(self, client, node_manager, jwt_secret):
        """JWT에 name/picture가 없어도 email/user_id만 채워지고 누락 필드는 dict에서 제외."""
        _, ws = await _register_node(node_manager)()
        # name·picture 미주입 → generate_token이 빈 문자열로 채움 → caller_info에서 제외
        token = generate_token({"email": "minimal@example.com"}, jwt_secret)
        resp = await client.post(
            "/api/sessions",
            json={"prompt": "test"},
            cookies={COOKIE_NAME: token},
        )
        assert resp.status_code == 201

        ci = _extract_ws_payload(ws)["caller_info"]
        assert ci["user_id"] == "minimal@example.com"
        assert ci["email"] == "minimal@example.com"
        # 빈 문자열 필드는 누락 (graceful)
        assert "display_name" not in ci
        assert "avatar_url" not in ci
