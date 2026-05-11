"""build_system_caller_info / build_agent_caller_info / build_bot_caller_info 단위 테스트.

F-11E (2026-05-09): build_system_caller_info 신설 — 소울스트림 서버 lifecycle 인터벤션의
발신자 신원 조립 helper.

R-3 (2026-05-11, atom G-5): B-1 + system 통합 — 빌더가 wire에 server-relative avatar_url
직접 박음. 정본 자산은 packages/soul-common/src/soul_common/portraits/{source}.png 단일.
호스팅은 orch-server `/api/system/portraits/{source}` (verify_auth 포함).
build_bot_caller_info 신설 — channel_observer / trello_watcher 봇 source 정체성 조립.
"""

from soul_common.auth.caller_info import (
    IDENTITY_BEARING_SOURCES,
    SYSTEM_PORTRAIT_BASE,
    build_agent_caller_info,
    build_bot_caller_info,
    build_system_caller_info,
)


class TestIdentityBearingSourcesConstant:
    """R-4 (atom G-13, 2026-05-11): IDENTITY_BEARING_SOURCES 공유 정본 단위.

    이전 R-2까지: orch session_serializer + soul-server task_factory + soul-server
    dashboard/user_profile 3 위치에 각자 `_IDENTITY_BEARING_SOURCES` 사본 (4 원소).
    R-4: soul_common.auth.caller_info 단일 정본으로 추출 + 봇/llm source 명시 포함 (7 원소).
    """

    def test_seven_elements(self):
        """R-4: agent/system/slack/soul-app + channel_observer/trello_watcher/llm — 7 원소."""
        assert IDENTITY_BEARING_SOURCES == frozenset({
            "agent",
            "system",
            "slack",
            "soul-app",
            "channel_observer",
            "trello_watcher",
            "llm",
        })

    def test_is_frozenset(self):
        """immutable frozenset — 모듈 정본을 호출자가 변경 못 함 (§3 정본 보호)."""
        assert isinstance(IDENTITY_BEARING_SOURCES, frozenset)

    def test_bot_sources_included_explicitly(self):
        """R-4 atom G-13: 봇/llm source 명시 포함 (우연 정합 제거)."""
        assert "channel_observer" in IDENTITY_BEARING_SOURCES
        assert "trello_watcher" in IDENTITY_BEARING_SOURCES
        assert "llm" in IDENTITY_BEARING_SOURCES

    def test_non_identity_sources_excluded(self):
        """browser/api는 IDENTITY_BEARING_SOURCES에 미포함 — owner fallback 발동 대상."""
        assert "browser" not in IDENTITY_BEARING_SOURCES
        assert "api" not in IDENTITY_BEARING_SOURCES
        assert "execute-proxy" not in IDENTITY_BEARING_SOURCES


class TestBuildSystemCallerInfo:
    """build_system_caller_info 통합 v1 스키마 정합 단언 (R-3 server-served 패턴)."""

    def test_returns_system_v1_dict(self):
        """node_id를 받아 v1 system caller_info dict를 조립한다 (R-3: server-relative avatar_url)."""
        result = build_system_caller_info(node_id="eias-shopping")

        assert result == {
            "source": "system",
            "agent_node": "eias-shopping",
            "display_name": "Soulstream",
            "user_id": None,
            "avatar_url": "/api/system/portraits/system",
        }

    def test_node_id_keyword_only(self):
        """node_id는 keyword-only 인자 — positional 호출 시 TypeError."""
        try:
            build_system_caller_info("eias-shopping")  # type: ignore[misc]
        except TypeError:
            return
        raise AssertionError("positional 호출이 TypeError를 일으켜야 한다")

    def test_avatar_url_server_relative(self):
        """avatar_url은 server-relative URL `/api/system/portraits/system` (R-3 fix).

        이전(F-11D~E): avatar_url=None으로 클라이언트가 정적 자산 표시 책임.
        R-3 (2026-05-11): server-served 단일 정본으로 통일 (§3, §9, §1 정합).
        """
        result = build_system_caller_info(node_id="any-node-id-123")
        assert result["avatar_url"] == f"{SYSTEM_PORTRAIT_BASE}/system"
        assert result["user_id"] is None

    def test_display_name_fixed_soulstream(self):
        """display_name은 'Soulstream' 고정 — node_id에 무관."""
        a = build_system_caller_info(node_id="node-A")
        b = build_system_caller_info(node_id="node-B")
        assert a["display_name"] == "Soulstream"
        assert b["display_name"] == "Soulstream"


class TestBuildBotCallerInfo:
    """build_bot_caller_info 통합 v1 스키마 정합 단언 (R-3 G-5)."""

    def test_channel_observer_v1_dict(self):
        """source/display_name 박힘, server-relative avatar_url, user_id=None, agent_node=None은 키 부재."""
        result = build_bot_caller_info(
            source="channel_observer",
            display_name="채널 관찰자",
        )
        assert result == {
            "source": "channel_observer",
            "display_name": "채널 관찰자",
            "user_id": None,
            "avatar_url": "/api/system/portraits/channel_observer",
        }

    def test_trello_watcher_v1_dict(self):
        """trello_watcher source 동일 패턴."""
        result = build_bot_caller_info(
            source="trello_watcher",
            display_name="트렐로 워처",
        )
        assert result == {
            "source": "trello_watcher",
            "display_name": "트렐로 워처",
            "user_id": None,
            "avatar_url": "/api/system/portraits/trello_watcher",
        }

    def test_agent_node_truthy_included(self):
        """agent_node 옵션 truthy일 때 caller_info에 포함."""
        result = build_bot_caller_info(
            source="channel_observer",
            display_name="채널 관찰자",
            agent_node="eias-shopping",
        )
        assert result["agent_node"] == "eias-shopping"

    def test_agent_node_none_omitted(self):
        """agent_node 옵션 None이면 caller_info 키 자체 부재 (graceful, §9 build_browser와 대칭)."""
        result = build_bot_caller_info(
            source="channel_observer",
            display_name="채널 관찰자",
            agent_node=None,
        )
        assert "agent_node" not in result

    def test_source_keyword_only(self):
        """source/display_name은 keyword-only — positional 호출 TypeError."""
        try:
            build_bot_caller_info("channel_observer", "채널 관찰자")  # type: ignore[misc]
        except TypeError:
            return
        raise AssertionError("positional 호출이 TypeError를 일으켜야 한다")

    def test_avatar_url_pattern(self):
        """avatar_url 패턴은 `{SYSTEM_PORTRAIT_BASE}/{source}` (정본 자산 위치와 §9 정합)."""
        result = build_bot_caller_info(
            source="custom_bot",
            display_name="Custom Bot",
        )
        assert result["avatar_url"] == "/api/system/portraits/custom_bot"


class TestBuildAgentCallerInfoExisting:
    """build_agent_caller_info 회귀 보호 — R-3 변경에 영향 받지 않음."""

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
