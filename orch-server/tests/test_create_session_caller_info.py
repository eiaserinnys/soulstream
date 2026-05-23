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

    F-9 fix(2026-05-08, side-fix): verify_auth가 `is_auth_enabled=True`인 환경에서만
    JWT 단계를 실행하도록 수정됐으므로(이전엔 무조건 실행 + auth_enabled=False bypass),
    JWT 검증 분기를 시험하려면 `google_client_id`도 함께 채워 `is_auth_enabled`를 True로
    만들어야 한다. 이전엔 jwt_secret만 채우고 verify_auth의 dev-mode bypass에 의존했다.

    function-scoped이라 다른 테스트 격리 보장. 테스트가 끝나면 settings는 자동 복원.
    """
    from soulstream_server.config import get_settings
    settings = get_settings()
    monkeypatch.setattr(settings, "jwt_secret", _TEST_JWT_SECRET)
    monkeypatch.setattr(settings, "google_client_id", "fake-client-id-for-test")
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
        client.cookies.set(COOKIE_NAME, token)
        resp = await client.post(
            "/api/sessions",
            json={"prompt": "test"},
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
        client.cookies.set(COOKIE_NAME, token)
        resp = await client.post(
            "/api/sessions",
            json={"prompt": "test", "caller_info": supplied},
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
        bad_token = generate_token(
            {"email": "x@y.z", "name": "x"},
            "wrong-jwt-secret-for-test-at-least-32-bytes",
        )
        client.cookies.set(COOKIE_NAME, bad_token)
        resp = await client.post(
            "/api/sessions",
            json={"prompt": "test"},
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

    async def test_jwt_partial_fields_routed_to_system(self, client, node_manager, jwt_secret):
        """R-6 (G-22) 정정: JWT에 name이 부재하면 *발급자 의도 = 자동 발사자*로 해석되어
        system caller_info로 분류된다 (B-7+B-4 결합).

        이전 R-5까지 expectation: cookie + email-only → browser, display_name/avatar_url 누락 graceful.
        R-6부터: cookie/Bearer 무관, JWT name 부재가 단독 트리거 → build_system_caller_info.
        cron-jobs/run_session.sh 같은 minimal payload 발급자를 자동 인식.

        false-positive 자연 회피: dev-login은 name='Developer' default(oauth_routes.py L223),
        OAuth는 Google userinfo.name 박음 → 사람 발신은 cookie+minimal-payload 경로로 들어오지 않음.
        """
        _, ws = await _register_node(node_manager)()
        # name·picture 미주입 → JWT payload에 name 없음 → R-6 분류 트리거
        token = generate_token({"email": "minimal@example.com"}, jwt_secret)
        client.cookies.set(COOKIE_NAME, token)
        resp = await client.post(
            "/api/sessions",
            json={"prompt": "test", "nodeId": "test-node"},
        )
        assert resp.status_code == 201

        ci = _extract_ws_payload(ws)["caller_info"]
        # R-6 분류 결과: system source
        assert ci["source"] == "system"
        assert ci["display_name"] == "Soulstream"
        assert ci["avatar_url"] == "/api/system/portraits/system"
        assert ci["agent_node"] == "test-node"
        assert ci["user_id"] is None
        # browser 메타는 박히지 않음 (system 분기, build_browser_caller_info 미발동)
        assert "user_agent" not in ci
        assert "ip" not in ci


class TestCallerInfoSystemRouting:
    """R-6 (2026-05-11, G-22): 외부 자동 호출자 진입 분류 — schedule cron / 스크립트류.

    cron-jobs/run_session.sh 같은 외부 자동 호출자가 발사한 세션을 서버가 진입 시점에
    system caller_info(display_name='Soulstream')로 분류하여 피드 카드 + 채팅 양쪽이
    일관 표시되도록 한다. 분류 정본은 soul_common.auth.caller_info.resolve_caller_info_or_system.

    분류 규칙: body.caller_info 부재 + JWT verify 성공 + payload.name falsy → system.

    호출자(cron-jobs): JWT_SECRET을 공유하여 자체적으로 JWT 발급, body에 caller_info 키 미박음.
    검증자(서버): JWT 내용으로 발급자 의도를 추론 (design-principles §1, §3).
    """

    async def test_bearer_minimal_jwt_routes_to_system(
        self, client, node_manager, jwt_secret
    ):
        """T-R6-O1: Bearer JWT email-only + body.caller_info 미박음 + nodeId 명시 → system 분류.

        cron-jobs/run_session.sh가 발사하는 정확한 시나리오:
        - Authorization: Bearer <JWT(email, exp)>
        - body: {prompt, nodeId, profile, folderId} — caller_info 키 부재
        """
        _, ws = await _register_node(node_manager)()
        # cron-jobs JWT payload — email + exp only, name/picture 없음
        token = generate_token({"email": "cron@example.com"}, jwt_secret)
        resp = await client.post(
            "/api/sessions",
            json={"prompt": "user-profile-update 스킬", "nodeId": "test-node"},
            headers={"Authorization": f"Bearer {token}", "user-agent": "curl/8.5.0"},
        )
        assert resp.status_code == 201

        ci = _extract_ws_payload(ws)["caller_info"]
        assert ci["source"] == "system"
        assert ci["display_name"] == "Soulstream"
        assert ci["avatar_url"] == "/api/system/portraits/system"
        # system_node_id에 body.nodeId 박힘
        assert ci["agent_node"] == "test-node"
        assert ci["user_id"] is None

    async def test_bearer_full_jwt_preserves_browser(
        self, client, node_manager, jwt_secret
    ):
        """T-R6-O2: Bearer JWT name+picture 박힘 → browser 분류 유지 (false-positive 회피).

        사람 PAT 사용자나 미래 모바일 클라이언트가 Bearer로 진입하며 JWT에 정체성을 박은 경우,
        R-6 분류가 발동하지 않고 기존 browser 흐름 유지 (B-7 단독 채택 시 회귀 위험을
        B-7+B-4 결합으로 차단).
        """
        _, ws = await _register_node(node_manager)()
        token = generate_token(
            {"email": "alice@example.com", "name": "Alice", "picture": "https://x/p"},
            jwt_secret,
        )
        resp = await client.post(
            "/api/sessions",
            json={"prompt": "test"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 201

        ci = _extract_ws_payload(ws)["caller_info"]
        assert ci["source"] == "browser"
        assert ci["display_name"] == "Alice"
        assert ci["user_id"] == "alice@example.com"
        assert ci["avatar_url"] == "https://x/p"

    async def test_body_caller_info_preserved_when_jwt_minimal(
        self, client, node_manager, jwt_secret
    ):
        """T-R6-O3: body.caller_info 명시 + Bearer minimal JWT → body 그대로 forward.

        슬랙/RN/위임은 body.caller_info를 명시 박는 N.1 패턴 — JWT 내용 무관, body 우선
        (기존 우선순위 보존). R-6 분류 dispatcher는 body 박힌 케이스를 분기 무관 처리.
        """
        _, ws = await _register_node(node_manager)()
        supplied = {"source": "agent", "agent_node": "n1", "agent_id": "a1"}
        token = generate_token({"email": "irrelevant@example.com"}, jwt_secret)
        resp = await client.post(
            "/api/sessions",
            json={"prompt": "test", "caller_info": supplied},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 201

        ci = _extract_ws_payload(ws)["caller_info"]
        # body 그대로 — system 분기 미발동, JWT 디코드 결과 미반영
        assert ci == supplied

    async def test_node_id_omitted_graceful_empty_agent_node(
        self, client, node_manager, jwt_secret
    ):
        """T-R6-O4: body.nodeId 부재 시 system_node_id=''로 graceful — agent_node=''.

        cron-jobs는 항상 nodeId를 명시하지만, 미래 다른 외부 호출자가 nodeId 없이 발사하면
        build_system_caller_info(node_id='')가 agent_node='' 반환. system source는 node_id
        식별과 무관(caller_info.py docstring 정합) — 정합."""
        _, ws = await _register_node(node_manager)()
        token = generate_token({"email": "headless@example.com"}, jwt_secret)
        resp = await client.post(
            "/api/sessions",
            json={"prompt": "test"},  # nodeId 부재
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 201

        ci = _extract_ws_payload(ws)["caller_info"]
        assert ci["source"] == "system"
        assert ci["agent_node"] == ""  # graceful empty


class TestInterveneCallerInfoSystemRouting:
    """R-7 (G-22): orch intervene 라우트에 caller_info system 분류 §9 대칭.

    intervene 라우트는 `find_session_node` *뒤*에서 caller_info 조립 — `system_node_id`로
    `node.node_id`(NodeConnection)가 들어간다. create_session 라우트와 §9 대칭이지만 순서
    변경이 있으므로 통합 회귀로 보장.
    """

    async def test_intervene_bearer_minimal_jwt_routes_to_system(
        self, client, node_manager, mock_db, jwt_secret
    ):
        """T-R6-O5 (P2-2 회귀): Bearer minimal JWT + intervene → system 분류, agent_node=node.node_id."""
        node, ws = await _register_node(node_manager)()
        # find_session_node 라우팅 — get_session이 node_id 반환 → node_manager.get_node(node_id)
        mock_db.get_session = AsyncMock(return_value={"node_id": node.node_id})

        # intervene 진입 (cron-jobs 시나리오)
        token = generate_token({"email": "cron@example.com"}, jwt_secret)
        resp = await client.post(
            f"/api/sessions/sess-routed/intervene",
            json={"text": "follow-up message"},
            headers={"Authorization": f"Bearer {token}", "user-agent": "curl/8.5.0"},
        )
        assert resp.status_code == 200, resp.text

        payload = _extract_ws_payload(ws)
        # send_intervene WS payload에 caller_info 박힘
        ci = payload["caller_info"]
        assert ci["source"] == "system"
        assert ci["display_name"] == "Soulstream"
        assert ci["avatar_url"] == "/api/system/portraits/system"
        # system_node_id=node.node_id ("test-node") 박힘
        assert ci["agent_node"] == node.node_id

    async def test_intervene_session_not_found_no_caller_info_assembly(
        self, client, node_manager, mock_db, jwt_secret
    ):
        """T-R6-O6: find_session_node 실패(노드 미등록 + 세션 미발견) → 404, caller_info 조립 미발동.

        순서 변경(R-7) 정합: find_session_node 예외 → caller_info dispatcher 미호출.
        기존 fastapi 자동 처리 정합 보존.

        node_manager에 노드 *미등록* + DB에 세션 *미발견* 둘 다 만족시켜야 find_session_node가
        활성 노드 fallback도 못 쓰고 404 던진다 (node_utils.py:30-38).
        """
        # _register_node 호출 안 함 — 활성 노드 0
        mock_db.get_session = AsyncMock(return_value=None)

        token = generate_token({"email": "cron@example.com"}, jwt_secret)
        resp = await client.post(
            "/api/sessions/sess-nonexistent/intervene",
            json={"text": "test"},
            headers={"Authorization": f"Bearer {token}"},
        )
        # find_session_node가 HTTPException(404) 던짐 — caller_info 조립 진입 못 함
        assert resp.status_code == 404
