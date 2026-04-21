"""
test_create_session_caller_info - POST /api/sessions에서 caller_info 수집·전파 검증.

orch-server는 HTTP Request에서 IP/헤더를 수집하여 caller_info를 조립하고,
node WS 페이로드에 그대로 전달해야 한다.

검증 기준:
1. body에 caller_info가 없으면 서버가 HTTP Request에서 수집한다 (source="browser").
2. body에 caller_info가 있으면 서버 수집을 건너뛰고 body 값을 그대로 사용한다.
3. 조립된 caller_info는 node_connection.send_create_session을 거쳐 WS 페이로드의 'caller_info' 키로 전달된다.
"""

from unittest.mock import AsyncMock

import pytest


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
            "parent_session_id": "sess-parent",
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
