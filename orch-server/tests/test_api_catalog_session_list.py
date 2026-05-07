"""GET /api/catalog의 sessionList 항목 userName/userPortraitUrl 검증.

caller_info(통합 스키마 v1, atom ed3a216d) 발신자 신원이 노드 user_info를
override하는지 확인한다. caller_info 부재 세션은 노드 user_info fallback이 보존된다.
"""

from unittest.mock import MagicMock

import pytest


@pytest.fixture
def node_with_user(node_manager, mock_node_connection):
    """node_manager에 user_info를 가진 노드를 등록.

    catalog.py가 node_manager.get_user_info(node_id)를 호출하므로
    실제 NodeConnection을 등록하여 fallback 경로(caller_info 부재 세션)를 검증한다.
    """
    # 실제 NodeManager.add_node는 async + WS handshake 필요하므로 직접 dict 주입
    # NodeManager._nodes는 dict[str, NodeConnection].
    mock_node_connection._user_info = {
        "name": "노드 사용자",
        "email": "node@example.com",
        "hasPortrait": True,
    }
    node_manager._nodes[mock_node_connection.node_id] = mock_node_connection
    return mock_node_connection


def _session_with_caller_info(session_id: str, node_id: str, caller_info_value: dict | None) -> dict:
    """test fixture — DB에서 반환되는 형태의 session row."""
    metadata = []
    if caller_info_value is not None:
        metadata.append({"type": "caller_info", "value": caller_info_value})
    return {
        "session_id": session_id,
        "node_id": node_id,
        "agent_id": None,
        "status": "running",
        "session_type": "claude",
        "created_at": "2026-05-07T00:00:00",
        "updated_at": "2026-05-07T00:00:00",
        "last_event_id": 0,
        "last_read_event_id": 0,
        "prompt": "hello",
        "last_message": None,
        "metadata": metadata,
    }


class TestCatalogSessionListUserInfo:
    """GET /api/catalog의 sessionList userName/userPortraitUrl 결정 정책."""

    async def test_caller_info_browser_overrides_node_user_info(
        self, client, mock_db, mock_catalog_service, node_with_user
    ):
        """caller_info source=browser → display_name/google picture override."""
        session = _session_with_caller_info("s1", node_with_user.node_id, {
            "source": "browser",
            "display_name": "Jubok Kim",
            "user_id": "eiaserinnys@gmail.com",
            "avatar_url": "https://lh3.googleusercontent.com/a/ABC",
            "email": "eiaserinnys@gmail.com",
        })
        mock_db.get_all_sessions.return_value = ([session], 1)
        mock_catalog_service.get_catalog.return_value = {
            "folders": [],
            "sessions": {"s1": {"folderId": None, "displayName": None}},
        }

        resp = await client.get("/api/catalog")

        assert resp.status_code == 200
        body = resp.json()
        assert len(body["sessionList"]) == 1
        item = body["sessionList"][0]
        assert item["userName"] == "Jubok Kim"
        assert item["userPortraitUrl"] == "https://lh3.googleusercontent.com/a/ABC"

    async def test_caller_info_slack_overrides_node_user_info(
        self, client, mock_db, mock_catalog_service, node_with_user
    ):
        """caller_info source=slack → image_192 url override."""
        session = _session_with_caller_info("s1", node_with_user.node_id, {
            "source": "slack",
            "display_name": "@channel-user",
            "user_id": "U08ABC",
            "avatar_url": "https://avatars.slack-edge.com/2024/img_192.png",
            "slack": {"channel_id": "C08", "user_id": "U08ABC"},
        })
        mock_db.get_all_sessions.return_value = ([session], 1)
        mock_catalog_service.get_catalog.return_value = {
            "folders": [],
            "sessions": {"s1": {"folderId": None, "displayName": None}},
        }

        resp = await client.get("/api/catalog")

        body = resp.json()
        item = body["sessionList"][0]
        assert item["userName"] == "@channel-user"
        assert item["userPortraitUrl"] == "https://avatars.slack-edge.com/2024/img_192.png"

    async def test_caller_info_agent_overrides_node_user_info(
        self, client, mock_db, mock_catalog_service, node_with_user
    ):
        """caller_info source=agent → /api/agents/.../portrait override."""
        session = _session_with_caller_info("s1", node_with_user.node_id, {
            "source": "agent",
            "display_name": "shay",
            "user_id": "shay",
            "avatar_url": "/api/agents/shay/portrait",
            "agent_node": "eiaserinnys",
            "agent_id": "shay",
            "agent_name": "Shay",
        })
        mock_db.get_all_sessions.return_value = ([session], 1)
        mock_catalog_service.get_catalog.return_value = {
            "folders": [],
            "sessions": {"s1": {"folderId": None, "displayName": None}},
        }

        resp = await client.get("/api/catalog")

        body = resp.json()
        item = body["sessionList"][0]
        assert item["userName"] == "shay"
        assert item["userPortraitUrl"] == "/api/agents/shay/portrait"

    async def test_caller_info_soul_app_overrides_node_user_info(
        self, client, mock_db, mock_catalog_service, node_with_user
    ):
        """caller_info source=soul-app → google picture override."""
        session = _session_with_caller_info("s1", node_with_user.node_id, {
            "source": "soul-app",
            "display_name": "Jubok Kim",
            "avatar_url": "https://lh3.googleusercontent.com/a/RN-PIC",
        })
        mock_db.get_all_sessions.return_value = ([session], 1)
        mock_catalog_service.get_catalog.return_value = {
            "folders": [],
            "sessions": {"s1": {"folderId": None, "displayName": None}},
        }

        resp = await client.get("/api/catalog")

        body = resp.json()
        item = body["sessionList"][0]
        assert item["userName"] == "Jubok Kim"
        assert item["userPortraitUrl"] == "https://lh3.googleusercontent.com/a/RN-PIC"

    async def test_caller_info_absent_uses_node_user_info(
        self, client, mock_db, mock_catalog_service, node_with_user
    ):
        """metadata에 caller_info 없으면 노드 user_info fallback (회귀 보호)."""
        session = _session_with_caller_info("s1", node_with_user.node_id, None)
        mock_db.get_all_sessions.return_value = ([session], 1)
        mock_catalog_service.get_catalog.return_value = {
            "folders": [],
            "sessions": {"s1": {"folderId": None, "displayName": None}},
        }

        resp = await client.get("/api/catalog")

        body = resp.json()
        item = body["sessionList"][0]
        assert item["userName"] == "노드 사용자"
        assert item["userPortraitUrl"] == f"/api/nodes/{node_with_user.node_id}/user/portrait"

    async def test_caller_info_avatar_url_empty_falls_back_to_none(
        self, client, mock_db, mock_catalog_service, node_with_user
    ):
        """avatar_url='' → caller_info 분기 진입했지만 avatar는 None (mix-fallback 금지)."""
        session = _session_with_caller_info("s1", node_with_user.node_id, {
            "source": "browser",
            "display_name": "익명",
            "avatar_url": "",
        })
        mock_db.get_all_sessions.return_value = ([session], 1)
        mock_catalog_service.get_catalog.return_value = {
            "folders": [],
            "sessions": {"s1": {"folderId": None, "displayName": None}},
        }

        resp = await client.get("/api/catalog")

        body = resp.json()
        item = body["sessionList"][0]
        assert item["userName"] == "익명"
        assert item["userPortraitUrl"] is None

    async def test_caller_info_agent_node_proxy_path_overrides(
        self, client, mock_db, mock_catalog_service, node_with_user
    ):
        """위임 신규 케이스 (260507.10 fix 후): build_agent_caller_info가 생성한
        노드 프록시 형식 avatar_url(/api/nodes/{node}/agents/{id}/portrait)이
        catalog 응답까지 정확히 통과되는지 단언.

        본 fix(260507.10)의 송신 측 invariant — 1-A·1-B가 build_agent_caller_info를
        통해 node proxy path를 채움 — 이 catalog 정본(session_serializer.caller_info →
        userPortraitUrl override)에서 그대로 통과되어야 한다.
        """
        agent_node_id = node_with_user.node_id
        avatar_url = f"/api/nodes/{agent_node_id}/agents/seosoyoung/portrait"
        session = _session_with_caller_info("s1", agent_node_id, {
            "source": "agent",
            "agent_node": agent_node_id,
            "agent_id": "seosoyoung",
            "agent_name": "서소영",
            "display_name": "서소영",
            "user_id": "seosoyoung",
            "avatar_url": avatar_url,
        })
        mock_db.get_all_sessions.return_value = ([session], 1)
        mock_catalog_service.get_catalog.return_value = {
            "folders": [],
            "sessions": {"s1": {"folderId": None, "displayName": None}},
        }

        resp = await client.get("/api/catalog")

        body = resp.json()
        item = body["sessionList"][0]
        assert item["userName"] == "서소영"
        assert item["userPortraitUrl"] == avatar_url
