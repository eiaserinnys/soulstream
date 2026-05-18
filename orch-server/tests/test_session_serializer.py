"""apply_user_profile_enrichment 헬퍼 단위 테스트.

R-1 fix(2026-05-08): catalog REST와 SSE wire 3변형이 user 프로필 채움 정책을
공유하도록 추출된 정본 헬퍼.

정책 — caller_info 정체성 우선, mix-fallback 금지(atom ed3a216d v1):
- payload[name_key] truthy → NOOP (정체성 부분이라도 있으면 보존)
- node_id 없음 또는 node_manager None → NOOP (graceful)
- get_user_info 빈 dict → NOOP
"""

from unittest.mock import MagicMock

from soulstream_server.api.session_serializer import (
    apply_agent_enrichment,
    apply_user_profile_enrichment,
)
from soulstream_server.nodes.node_manager import NodeManager


def _make_node_manager(user_info: dict | None) -> MagicMock:
    """get_user_info가 user_info를 반환하는 NodeManager mock.

    user_info=None은 빈 dict 반환과 동치 (NodeManager.get_user_info의 graceful 패턴).
    """
    nm = MagicMock(spec=NodeManager)
    nm.get_user_info = MagicMock(return_value=user_info or {})
    return nm


class TestApplyUserProfileEnrichment:
    """헬퍼 정책 5 케이스 매트릭스."""

    def test_t1_fills_name_and_portrait_when_payload_empty(self):
        """T1: payload userName=None + node_id 있음 + user_info 충실 → name + portrait 채움."""
        payload = {"userName": None, "userPortraitUrl": None}
        nm = _make_node_manager({"name": "노드 사용자", "hasPortrait": True})

        apply_user_profile_enrichment(
            payload, node_id="node-1", node_manager=nm
        )

        assert payload["userName"] == "노드 사용자"
        assert payload["userPortraitUrl"] == "/api/nodes/node-1/user/portrait"
        nm.get_user_info.assert_called_once_with("node-1")

    def test_t2_noop_when_username_truthy(self):
        """T2: payload userName='alice' truthy → NOOP (mix-fallback 금지).

        caller_info 정체성이 부분이라도 있으면 노드 정보로 덮어쓰지 않는다.
        """
        payload = {"userName": "alice", "userPortraitUrl": None}
        nm = _make_node_manager({"name": "노드 사용자", "hasPortrait": True})

        apply_user_profile_enrichment(
            payload, node_id="node-1", node_manager=nm
        )

        assert payload["userName"] == "alice"
        assert payload["userPortraitUrl"] is None  # 노드 portrait로 mix-fallback 안 함
        nm.get_user_info.assert_not_called()

    def test_t2b_noop_when_portrait_truthy_but_name_empty(self):
        """T2-b: caller_info에 avatar_url만 있고 display_name 비어있는 부분 케이스.

        payload userName=None + userPortraitUrl='https://...' (truthy) → NOOP.
        portrait가 caller_info에서 채워졌으면 caller_info 정체성이 있다고 간주 —
        노드 정보로 mix-fallback하지 않는다 (atom ed3a216d 정책).
        """
        payload = {"userName": None, "userPortraitUrl": "https://example.com/a.png"}
        nm = _make_node_manager({"name": "노드 사용자", "hasPortrait": True})

        apply_user_profile_enrichment(
            payload, node_id="node-1", node_manager=nm
        )

        assert payload["userName"] is None  # 노드 name으로 mix-fallback 안 함
        assert payload["userPortraitUrl"] == "https://example.com/a.png"  # 보존
        nm.get_user_info.assert_not_called()

    def test_t3_noop_when_node_id_none(self):
        """T3: payload userName=None + node_id=None → NOOP (graceful)."""
        payload = {"userName": None, "userPortraitUrl": None}
        nm = _make_node_manager({"name": "노드 사용자", "hasPortrait": True})

        apply_user_profile_enrichment(
            payload, node_id=None, node_manager=nm
        )

        assert payload == {"userName": None, "userPortraitUrl": None}
        nm.get_user_info.assert_not_called()

    def test_t3b_noop_when_node_manager_none(self):
        """T3-b: payload userName=None + node_manager=None → NOOP (graceful)."""
        payload = {"userName": None, "userPortraitUrl": None}

        apply_user_profile_enrichment(
            payload, node_id="node-1", node_manager=None
        )

        assert payload == {"userName": None, "userPortraitUrl": None}

    def test_t4_noop_when_user_info_empty(self):
        """T4: get_user_info 빈 dict → NOOP (노드 등록 직후·연결 끊긴 노드)."""
        payload = {"userName": None, "userPortraitUrl": None}
        nm = _make_node_manager({})

        apply_user_profile_enrichment(
            payload, node_id="node-1", node_manager=nm
        )

        assert payload == {"userName": None, "userPortraitUrl": None}
        nm.get_user_info.assert_called_once_with("node-1")

    def test_t5_fills_name_only_when_no_portrait(self):
        """T5: user_info에 hasPortrait=False → name만 채움, portrait_key 미터치."""
        payload = {"userName": None, "userPortraitUrl": None}
        nm = _make_node_manager({"name": "노드 사용자", "hasPortrait": False})

        apply_user_profile_enrichment(
            payload, node_id="node-1", node_manager=nm
        )

        assert payload["userName"] == "노드 사용자"
        assert payload["userPortraitUrl"] is None  # caller가 사전 set한 None 보존

    def test_t5b_user_info_name_empty_skips_name_assignment(self):
        """T5-b: user_info.name이 falsy → name도 스킵 (truthy 가드)."""
        payload = {"userName": None, "userPortraitUrl": None}
        nm = _make_node_manager({"name": "", "hasPortrait": True})

        apply_user_profile_enrichment(
            payload, node_id="node-1", node_manager=nm
        )

        # name이 빈 문자열이면 set하지 않음 (truthy 가드)
        assert payload["userName"] is None
        # 그러나 hasPortrait는 True이므로 portrait는 채움 — name과 독립 키
        assert payload["userPortraitUrl"] == "/api/nodes/node-1/user/portrait"

    def test_custom_keys(self):
        """커스텀 name_key/portrait_key 인자가 적용되는지 검증."""
        payload = {"customName": None, "customPortrait": None}
        nm = _make_node_manager({"name": "Bob", "hasPortrait": True})

        apply_user_profile_enrichment(
            payload,
            node_id="node-2",
            node_manager=nm,
            name_key="customName",
            portrait_key="customPortrait",
        )

        assert payload["customName"] == "Bob"
        assert payload["customPortrait"] == "/api/nodes/node-2/user/portrait"


def _make_agent_node_manager(profile: dict | None, source_node_id: str | None = "node-A") -> MagicMock:
    """find_agent_profile이 (profile, source_node_id) 튜플 또는 None을 반환하는 NodeManager mock."""
    nm = MagicMock(spec=NodeManager)
    if profile is None:
        nm.find_agent_profile = MagicMock(return_value=None)
    else:
        nm.find_agent_profile = MagicMock(return_value=(profile, source_node_id))
    return nm


class TestApplyAgentEnrichment:
    """Phase A backend 정본 단일화 helper (T-6, atom d7a1ad86 차단).

    `_session_to_response`(REST catalog)와 `main._on_node_change`(session_created live wire)
    양쪽이 같은 helper를 호출하여 backend default 정책 공유.
    """

    def test_t6_1_fills_backend_name_portrait_on_profile_lookup_success(self):
        payload = {"agentName": None, "agentPortraitUrl": None, "backend": None}
        nm = _make_agent_node_manager(
            {"name": "Codex Default", "backend": "codex", "portrait_url": "/codex.png"}
        )

        apply_agent_enrichment(
            payload, agent_id="codex-default", node_id="node-A", node_manager=nm
        )

        assert payload["agentName"] == "Codex Default"
        assert payload["backend"] == "codex"
        assert payload["agentPortraitUrl"] == "/api/nodes/node-A/agents/codex-default/portrait"

    def test_t6_2_backend_default_claude_when_profile_missing_backend_key(self):
        """profile 있지만 backend 키 부재 → default 'claude'."""
        payload = {"agentName": None, "agentPortraitUrl": None, "backend": None}
        nm = _make_agent_node_manager(
            {"name": "Claude Default", "portrait_url": "/claude.png"}
        )

        apply_agent_enrichment(
            payload, agent_id="claude-default", node_id="node-A", node_manager=nm
        )

        assert payload["backend"] == "claude"

    def test_t6_3_noop_when_agent_id_none(self):
        """agent_id 부재 → NOOP, 호출자가 박은 default 보존."""
        payload = {"agentName": None, "agentPortraitUrl": None, "backend": "claude"}
        nm = _make_agent_node_manager(
            {"name": "X", "backend": "codex", "portrait_url": "/x.png"}
        )

        apply_agent_enrichment(
            payload, agent_id=None, node_id="node-A", node_manager=nm
        )

        assert payload == {"agentName": None, "agentPortraitUrl": None, "backend": "claude"}
        nm.find_agent_profile.assert_not_called()

    def test_t6_4_noop_when_node_manager_none(self):
        payload = {"agentName": None, "agentPortraitUrl": None, "backend": "claude"}
        apply_agent_enrichment(
            payload, agent_id="codex-default", node_id="node-A", node_manager=None
        )
        assert payload == {"agentName": None, "agentPortraitUrl": None, "backend": "claude"}

    def test_t6_5_noop_when_profile_not_found_preserves_caller_default(self):
        """profile lookup 실패 → 호출자가 박은 default 보존 (TS broadcaster 'claude' 등)."""
        payload = {"agentName": None, "agentPortraitUrl": None, "backend": "claude"}
        nm = _make_agent_node_manager(None)

        apply_agent_enrichment(
            payload, agent_id="ghost", node_id="node-A", node_manager=nm
        )

        # backend는 caller가 박은 "claude" 그대로 보존 — overwrite 안 함.
        assert payload["backend"] == "claude"
        nm.find_agent_profile.assert_called_once_with("ghost", "node-A")

    def test_t6_6_skips_portrait_when_url_missing(self):
        """portrait_url 부재 → agentPortraitUrl 미터치 (caller가 박은 default 보존)."""
        payload = {"agentName": None, "agentPortraitUrl": None, "backend": None}
        nm = _make_agent_node_manager(
            {"name": "No Portrait Agent", "backend": "codex"}
        )

        apply_agent_enrichment(
            payload, agent_id="no-portrait", node_id="node-A", node_manager=nm
        )

        assert payload["agentName"] == "No Portrait Agent"
        assert payload["backend"] == "codex"
        assert payload["agentPortraitUrl"] is None
