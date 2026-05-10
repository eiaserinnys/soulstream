"""test_session_serializer_caller_source — R-2 caller_source 인식 회귀.

R-2 fix(2026-05-10) — atom 0499ee7b·0d366900:
- `apply_user_profile_enrichment`에 caller_source 인자 추가.
- 정체성 명시 source(agent/system/slack/soul-app)는 신원 필드 None이어도
  node owner Google portrait로 덮지 않는다.
- browser/api/None은 기존 동작 그대로 — 신원 truthy면 NOOP, 부재면 fallback.

매트릭스 — 7 source × payload 상태 + `_session_to_response` 통합 케이스 (T-G2-A').
"""
from unittest.mock import MagicMock

import pytest

from soulstream_server.api.session_serializer import (
    _session_to_response,
    apply_user_profile_enrichment,
)


def _make_node_manager(node_user_info: dict | None = None):
    """user_info를 반환하는 NodeManager mock."""
    nm = MagicMock()
    nm.get_user_info.return_value = node_user_info or {}
    nm.find_agent_profile.return_value = None
    return nm


class TestApplyUserProfileEnrichmentCallerSource:
    """헬퍼 단위 — caller_source 분기 매트릭스 (T-G2-A)."""

    def _node_info(self):
        return {"name": "OwnerName", "hasPortrait": True}

    @pytest.mark.parametrize(
        "source",
        ["agent", "system", "slack", "soul-app"],
    )
    def test_identity_bearing_source_noop_with_empty_identity(self, source):
        """정체성 명시 source — 신원 None이어도 NOOP."""
        payload = {"userName": None, "userPortraitUrl": None}
        nm = _make_node_manager(self._node_info())
        apply_user_profile_enrichment(
            payload,
            node_id="node-1",
            node_manager=nm,
            caller_source=source,
        )
        assert payload["userName"] is None
        assert payload["userPortraitUrl"] is None
        nm.get_user_info.assert_not_called()  # 짧은 회로

    def test_browser_source_empty_identity_falls_back(self):
        """browser source + 신원 None → node owner fallback."""
        payload = {"userName": None, "userPortraitUrl": None}
        nm = _make_node_manager(self._node_info())
        apply_user_profile_enrichment(
            payload,
            node_id="node-1",
            node_manager=nm,
            caller_source="browser",
        )
        assert payload["userName"] == "OwnerName"
        assert payload["userPortraitUrl"] == "/api/nodes/node-1/user/portrait"

    def test_browser_source_truthy_identity_noop(self):
        """browser source + 신원 truthy → 기존 truthy 가드로 NOOP."""
        payload = {"userName": "RealUser", "userPortraitUrl": "/x"}
        nm = _make_node_manager(self._node_info())
        apply_user_profile_enrichment(
            payload,
            node_id="node-1",
            node_manager=nm,
            caller_source="browser",
        )
        assert payload["userName"] == "RealUser"
        assert payload["userPortraitUrl"] == "/x"

    def test_api_source_falls_back(self):
        """api source + 신원 None → owner fallback."""
        payload = {"userName": None, "userPortraitUrl": None}
        nm = _make_node_manager(self._node_info())
        apply_user_profile_enrichment(
            payload,
            node_id="node-1",
            node_manager=nm,
            caller_source="api",
        )
        assert payload["userName"] == "OwnerName"

    def test_caller_source_none_falls_back(self):
        """caller_source 미지정(None) → 기존 R-1 동작."""
        payload = {"userName": None, "userPortraitUrl": None}
        nm = _make_node_manager(self._node_info())
        apply_user_profile_enrichment(
            payload,
            node_id="node-1",
            node_manager=nm,
            # caller_source 미전달
        )
        assert payload["userName"] == "OwnerName"

    def test_unknown_source_falls_back(self):
        """알 수 없는 source → fallback (browser와 같은 분류)."""
        payload = {"userName": None, "userPortraitUrl": None}
        nm = _make_node_manager(self._node_info())
        apply_user_profile_enrichment(
            payload,
            node_id="node-1",
            node_manager=nm,
            caller_source="channel_observer",
        )
        assert payload["userName"] == "OwnerName"

    def test_no_node_manager_noop(self):
        """node_manager=None → graceful NOOP (caller_source 무관)."""
        payload = {"userName": None, "userPortraitUrl": None}
        apply_user_profile_enrichment(
            payload,
            node_id="node-1",
            node_manager=None,
            caller_source="browser",
        )
        assert payload["userName"] is None


class TestSessionToResponseAgentSourceIntegration:
    """T-G2-A' 통합 — agent source DB 레코드가 `_session_to_response`에서 owner로 덮이지 않는다.

    회로: DB metadata에 caller_info(source='agent', display_name=None, avatar_url=None)
    → _session_to_response 추출 → enrichment 헬퍼에 caller_source='agent' forward
    → NOOP → 응답에 userName/userPortraitUrl 모두 None.
    """

    def test_agent_source_empty_identity_no_owner_fallback(self):
        """agent caller_info의 display_name·avatar_url 모두 None → owner 미주입."""
        nm = _make_node_manager({"name": "DashboardOwner", "hasPortrait": True})
        row = {
            "session_id": "sess-1",
            "status": "running",
            "node_id": "node-1",
            "agent_id": None,
            "metadata": [
                {"type": "caller_info", "value": {
                    "source": "agent",
                    "agent_node": "node-1",
                    "agent_id": "ag-x",
                    "agent_name": None,  # registry 미등록 케이스
                    "display_name": None,
                    "avatar_url": None,
                }},
            ],
        }
        result = _session_to_response(row, node_manager=nm)
        # agent caller_info의 신원 부재여도 dashboard owner Google portrait로 덮이지 않는다.
        assert result["userName"] is None
        assert result["userPortraitUrl"] is None

    def test_agent_source_with_identity_preserved(self):
        """agent caller_info의 신원 있음 → 그대로 보존 (NOOP, owner 미주입)."""
        nm = _make_node_manager({"name": "DashboardOwner", "hasPortrait": True})
        row = {
            "session_id": "sess-2",
            "status": "running",
            "node_id": "node-1",
            "agent_id": None,
            "metadata": [
                {"type": "caller_info", "value": {
                    "source": "agent",
                    "agent_node": "node-1",
                    "agent_id": "ag-y",
                    "agent_name": "Eve",
                    "display_name": "Eve",
                    "avatar_url": "/api/nodes/node-1/agents/ag-y/portrait",
                }},
            ],
        }
        result = _session_to_response(row, node_manager=nm)
        assert result["userName"] == "Eve"
        assert result["userPortraitUrl"] == "/api/nodes/node-1/agents/ag-y/portrait"

    def test_browser_source_empty_identity_falls_back(self):
        """browser caller_info의 신원 부재 → owner fallback (기존 R-1 회귀 보존)."""
        nm = _make_node_manager({"name": "DashboardOwner", "hasPortrait": True})
        row = {
            "session_id": "sess-3",
            "status": "running",
            "node_id": "node-1",
            "agent_id": None,
            "metadata": [
                {"type": "caller_info", "value": {
                    "source": "browser",
                    "ip": "127.0.0.1",
                }},
            ],
        }
        result = _session_to_response(row, node_manager=nm)
        # browser는 본인 정체성 명시 source가 아님 — owner로 fallback이 의도.
        assert result["userName"] == "DashboardOwner"
        assert result["userPortraitUrl"] == "/api/nodes/node-1/user/portrait"

    def test_no_caller_info_falls_back(self):
        """caller_info 부재 → owner fallback (기존 R-1 회귀 보존)."""
        nm = _make_node_manager({"name": "DashboardOwner", "hasPortrait": True})
        row = {
            "session_id": "sess-4",
            "status": "running",
            "node_id": "node-1",
            "agent_id": None,
            "metadata": [],
        }
        result = _session_to_response(row, node_manager=nm)
        assert result["userName"] == "DashboardOwner"
