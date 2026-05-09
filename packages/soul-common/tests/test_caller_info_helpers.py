"""build_system_caller_info / build_agent_caller_info 단위 테스트.

F-11E (2026-05-09, atom F-11): build_system_caller_info 신설 — 소울스트림 서버
lifecycle 인터벤션의 발신자 신원 조립 helper. avatar_url=None은 클라이언트가 자기 정적
자산으로 표시하도록 *지식 경계* 분리 (design-principles §1).
"""

from soul_common.auth.caller_info import (
    build_agent_caller_info,
    build_system_caller_info,
)


class TestBuildSystemCallerInfo:
    """build_system_caller_info 통합 v1 스키마 정합 단언."""

    def test_returns_system_v1_dict(self):
        """node_id를 받아 v1 system caller_info dict를 조립한다."""
        result = build_system_caller_info(node_id="eias-shopping")

        assert result == {
            "source": "system",
            "agent_node": "eias-shopping",
            "display_name": "Soulstream",
            "user_id": None,
            "avatar_url": None,
        }

    def test_node_id_keyword_only(self):
        """node_id는 keyword-only 인자 — positional 호출 시 TypeError."""
        try:
            build_system_caller_info("eias-shopping")  # type: ignore[misc]
        except TypeError:
            return
        raise AssertionError("positional 호출이 TypeError를 일으켜야 한다")

    def test_avatar_url_always_none(self):
        """avatar_url은 항상 None — 클라이언트 측이 자기 정적 자산으로 표시 (지식 경계)."""
        result = build_system_caller_info(node_id="any-node-id-123")
        assert result["avatar_url"] is None
        assert result["user_id"] is None

    def test_display_name_fixed_soulstream(self):
        """display_name은 'Soulstream' 고정 — node_id에 무관."""
        a = build_system_caller_info(node_id="node-A")
        b = build_system_caller_info(node_id="node-B")
        assert a["display_name"] == "Soulstream"
        assert b["display_name"] == "Soulstream"


class TestBuildAgentCallerInfoExisting:
    """build_agent_caller_info 회귀 보호 — F-11 변경에 영향 받지 않음."""

    def test_full_profile_v1_dict(self):
        """portrait_path + agent_id 모두 truthy면 avatar_url에 노드 프록시 URL 부여."""
        result = build_agent_caller_info(
            agent_node="eias-shopping",
            agent_id="shay",
            agent_name="Shay",
            portrait_path="/portraits/shay.png",
        )
        assert result["source"] == "agent"
        assert result["agent_node"] == "eias-shopping"
        assert result["agent_id"] == "shay"
        assert result["agent_name"] == "Shay"
        assert result["display_name"] == "Shay"
        assert result["user_id"] == "shay"
        assert result["avatar_url"] == "/api/nodes/eias-shopping/agents/shay/portrait"

    def test_no_portrait_path_avatar_url_none(self):
        """portrait_path None이면 avatar_url None (graceful)."""
        result = build_agent_caller_info(
            agent_node="eias-shopping",
            agent_id="shay",
            agent_name="Shay",
            portrait_path=None,
        )
        assert result["avatar_url"] is None
