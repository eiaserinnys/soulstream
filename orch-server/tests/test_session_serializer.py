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
