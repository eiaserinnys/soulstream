"""GET /api/catalog의 sessionList 항목 userName/userPortraitUrl 검증.

caller_info(통합 스키마 v1, atom ed3a216d) 발신자 신원이 노드 user_info를
override하는지 확인한다. caller_info 부재 세션은 노드 user_info fallback이 보존된다.

Phase A-bis(2026-05-16): sessionList build를 _session_to_response 정본 helper로
통일. 응답 키는 camelCase로 통일되고 backend 키가 박힘 — 정본 둘 안티패턴
(atom d7a1ad86) 차단. 기존 userName/userPortraitUrl 케이스 7개는 camelCase 키만
검증하므로 회귀 0. 신규 케이스로 backend 박힘 + camelCase 통일을 검증한다.
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


@pytest.fixture
def node_with_agent_profile(node_manager, mock_node_connection):
    """agent_profiles가 등록된 노드를 node_manager에 등록.

    Phase A-bis: catalog sessionList의 backend 키가 _session_to_response 정본
    helper를 통해 profile.backend("claude")로 채워지는지 검증하는 fixture.
    """
    mock_node_connection._agent_profiles = {
        "agent-claude-1": {
            "id": "agent-claude-1",
            "name": "Claude Agent",
            "backend": "claude",
            "portrait_url": "/api/agents/agent-claude-1/portrait",
        },
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


def _session_with_agent(session_id: str, node_id: str, agent_id: str | None) -> dict:
    """Phase A-bis: backend/agent profile lookup 검증용 session row fixture."""
    return {
        "session_id": session_id,
        "node_id": node_id,
        "agent_id": agent_id,
        "status": "running",
        "session_type": "claude",
        "created_at": "2026-05-16T00:00:00",
        "updated_at": "2026-05-16T00:00:00",
        "last_event_id": 0,
        "last_read_event_id": 0,
        "prompt": "hello",
        "last_message": None,
        "metadata": [],
    }


class TestCatalogSessionListBackend:
    """Phase A-bis: catalog sessionList의 backend 키 박힘 + camelCase 응답 키 통일.

    자리 1·2(정본 helper _session_to_response) 통일 후, catalog 응답이 helper와
    동일한 키 셋을 가지는지 검증한다. 정본 둘 안티패턴(atom d7a1ad86) 회귀 차단.
    """

    async def test_agent_session_includes_backend_from_profile(
        self, client, mock_db, mock_catalog_service, node_with_agent_profile
    ):
        """agent 세션에 profile.backend="claude" 박힘 (R1 — 본 PR 직접 목적)."""
        session = _session_with_agent("s1", node_with_agent_profile.node_id, "agent-claude-1")
        mock_db.get_all_sessions.return_value = ([session], 1)
        mock_catalog_service.get_catalog.return_value = {
            "folders": [],
            "sessions": {"s1": {"folderId": None, "displayName": None}},
            "boardItems": [
                {
                    "id": "session:s1",
                    "folderId": "f1",
                    "itemType": "session",
                    "itemId": "s1",
                    "x": 40,
                    "y": 80,
                    "metadata": {},
                }
            ],
        }

        resp = await client.get("/api/catalog")

        assert resp.status_code == 200
        body = resp.json()
        assert body["boardItems"] == [
            {
                "id": "session:s1",
                "folderId": "f1",
                "itemType": "session",
                "itemId": "s1",
                "x": 40,
                "y": 80,
                "metadata": {},
            }
        ]
        item = body["sessionList"][0]
        assert item["backend"] == "claude"
        assert item["agentId"] == "agent-claude-1"
        assert item["agentName"] == "Claude Agent"

    async def test_non_agent_session_backend_is_none(
        self, client, mock_db, mock_catalog_service
    ):
        """agent_id=None 세션은 backend=None (LLM/browser 직접 세션)."""
        session = _session_with_agent("s1", "test-node-1", None)
        mock_db.get_all_sessions.return_value = ([session], 1)
        mock_catalog_service.get_catalog.return_value = {
            "folders": [],
            "sessions": {"s1": {"folderId": None, "displayName": None}},
        }

        resp = await client.get("/api/catalog")

        item = resp.json()["sessionList"][0]
        assert "backend" in item, "backend 키는 항상 응답에 포함되어야 함 (None일지언정)"
        assert item["backend"] is None
        assert item["agentId"] is None

    async def test_agent_profile_miss_backend_is_none(
        self, client, mock_db, mock_catalog_service
    ):
        """agent_id 있으나 NodeManager에 profile 미등록 → backend=None.

        find_agent_profile 미스 — 노드 재시작 직후 reconnect 진행 중인 케이스
        (결함 진단 캐시 §7.2 시나리오). entry["backend"]가 None으로 명시 박힘.
        """
        session = _session_with_agent("s1", "test-node-1", "unknown-agent")
        mock_db.get_all_sessions.return_value = ([session], 1)
        mock_catalog_service.get_catalog.return_value = {
            "folders": [],
            "sessions": {"s1": {"folderId": None, "displayName": None}},
        }

        resp = await client.get("/api/catalog")

        item = resp.json()["sessionList"][0]
        assert item["backend"] is None
        assert item["agentId"] == "unknown-agent"
        # profile miss이므로 agentName/agentPortraitUrl도 None
        assert item["agentName"] is None
        assert item["agentPortraitUrl"] is None

    async def test_response_keys_are_camelcase(
        self, client, mock_db, mock_catalog_service, node_with_agent_profile
    ):
        """응답 키가 camelCase로 통일 — 자리 1 helper와 동일 키 셋.

        snake_case 키(session_id, node_id, created_at, ...)가 더 이상 응답에 없고
        camelCase 키(agentSessionId, nodeId, createdAt, ...)만 박힘. 자리 1·2
        정본 단일화 회귀 차단.
        """
        session = _session_with_agent("s-camel", node_with_agent_profile.node_id, "agent-claude-1")
        mock_db.get_all_sessions.return_value = ([session], 1)
        mock_catalog_service.get_catalog.return_value = {
            "folders": [],
            "sessions": {"s-camel": {"folderId": "f-1", "displayName": "Renamed"}},
        }

        resp = await client.get("/api/catalog")

        item = resp.json()["sessionList"][0]
        # camelCase 키 박힘 (자리 1 _session_to_response와 동일 셋)
        expected_keys = {
            "agentSessionId", "status", "prompt", "createdAt", "updatedAt",
            "sessionType", "lastMessage", "clientId", "metadata", "displayName",
            "nodeId", "folderId", "lastEventId", "lastReadEventId",
            "callerSessionId", "agentId", "agentName", "agentPortraitUrl",
            "backend", "userName", "userPortraitUrl",
        }
        assert expected_keys.issubset(set(item.keys())), (
            f"helper 응답 키 누락: {expected_keys - set(item.keys())}"
        )
        # snake_case 키 부재 (자리 2 inline build 폐기 회귀)
        forbidden_keys = {
            "session_id", "node_id", "folder_id", "display_name", "last_message",
            "session_type", "created_at", "updated_at", "last_event_id",
            "last_read_event_id", "agent_id", "caller_session_id", "client_id",
        }
        assert not (set(item.keys()) & forbidden_keys), (
            f"snake_case 잔존: {set(item.keys()) & forbidden_keys}"
        )
        # folder_id/display_name이 folder_assignments에서 정확히 보충됐는지 (catalog 도메인)
        assert item["folderId"] == "f-1"
        assert item["displayName"] == "Renamed"
        # agentSessionId가 session_id에서 변환됐는지
        assert item["agentSessionId"] == "s-camel"
