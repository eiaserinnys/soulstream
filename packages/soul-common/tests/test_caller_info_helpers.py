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
    extract_caller_info_from_metadata,
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


class TestExtractCallerInfoFromMetadata:
    """`extract_caller_info_from_metadata` 정책 단언.

    R-6 fix(2026-05-11, G-20): metadata array를 *append-only history ledger*로 취급하고,
    호출자가 *현재 caller*를 알 수 있도록 *마지막 신원 박힌 caller_info entry*를 반환한다.
    이전 (F-9~R-5): 첫 caller_info entry 반환 — `task_factory._resume_existing_task_locked`가
    intervene 시 `task.caller_info`만 인메모리 갱신하고 `append_metadata`를 호출하지 않아
    REST 응답(DB-derived)과 SSE wire(in-memory-derived) 시간 축 비대칭 회로(sess-20260419114049).

    정책:
    1. 마지막 *신원 박힌* caller_info entry 우선 (display_name truthy 또는 avatar_url truthy
       또는 source ∈ IDENTITY_BEARING_SOURCES — `task_factory._has_identity`와 §9 대칭)
    2. 부재 시 마지막 *어떤* caller_info entry라도 (graceful — 옛 데이터 보존)
    3. metadata 전체에 caller_info entry 0건 → None
    """

    def test_empty_metadata_returns_none(self):
        """metadata 빈 배열 → None (graceful)."""
        assert extract_caller_info_from_metadata([]) is None

    def test_metadata_none_returns_none(self):
        """metadata None → None (graceful)."""
        assert extract_caller_info_from_metadata(None) is None

    def test_no_caller_info_entries_returns_none(self):
        """caller_info type 부재 (다른 type만) → None."""
        metadata = [
            {"type": "other", "value": {"foo": "bar"}},
            {"type": "another", "value": "x"},
        ]
        assert extract_caller_info_from_metadata(metadata) is None

    def test_single_identity_entry_returns_it(self):
        """신원 박힌 caller_info 1개 → 그 entry value 반환."""
        metadata = [
            {"type": "caller_info", "value": {
                "source": "slack",
                "display_name": "スバル",
                "avatar_url": "https://slack-edge.com/.../192.png",
            }},
        ]
        result = extract_caller_info_from_metadata(metadata)
        assert result == {
            "source": "slack",
            "display_name": "スバル",
            "avatar_url": "https://slack-edge.com/.../192.png",
        }

    def test_single_no_identity_entry_returns_it_graceful(self):
        """신원 부재 caller_info 1개 → 그 entry 반환 (graceful, 옛 데이터 보존).

        이전 R-2 G-9 fix 이전 영속화된 browser 등 caller_info 케이스. 신원 부재여도 None 대신
        존재하는 entry를 반환하여 enrichment 헬퍼가 source 분기로 처리.
        """
        metadata = [
            {"type": "caller_info", "value": {
                "source": "browser",
                "ip": "127.0.0.1",
            }},
        ]
        result = extract_caller_info_from_metadata(metadata)
        assert result == {"source": "browser", "ip": "127.0.0.1"}

    def test_old_no_identity_then_new_identity_returns_last_identity(self):
        """G-20 핵심 케이스: 옛 신원 부재 entry + 새 신원 박힌 entry → 새 entry 반환.

        sess-20260419114049-8cf09982 시뮬레이션 — R-2 fix 이전 entry는 신원 부재,
        R-2 fix 이후 intervene으로 새 신원 박힌 entry append. 호출자는 *현재 caller*를 봐야
        한다 (이전 첫 entry 정책은 옛 신원 부재 entry를 반환 → owner fallback 발동 회로).
        """
        metadata = [
            {"type": "caller_info", "value": {"source": "slack"}},
            {"type": "caller_info", "value": {
                "source": "slack",
                "display_name": "スバル",
                "avatar_url": "https://slack-edge.com/.../192.png",
                "user_id": "U0A9ELR53R8",
            }},
        ]
        result = extract_caller_info_from_metadata(metadata)
        assert result["display_name"] == "スバル"
        assert result["avatar_url"] == "https://slack-edge.com/.../192.png"

    def test_two_identity_entries_returns_last_one(self):
        """신원 박힌 entry 2개 → 마지막 entry 반환 (caller 변경 이력 추적).

        사용자 신원 변경(슬랙 닉네임 변경, agent reassign 등) 시 가장 최근 신원이 표시되어야
        한다 — append-only ledger 정합.
        """
        metadata = [
            {"type": "caller_info", "value": {
                "source": "slack",
                "display_name": "OldName",
                "user_id": "U_OLD",
            }},
            {"type": "caller_info", "value": {
                "source": "slack",
                "display_name": "NewName",
                "user_id": "U_NEW",
            }},
        ]
        result = extract_caller_info_from_metadata(metadata)
        assert result["display_name"] == "NewName"
        assert result["user_id"] == "U_NEW"

    def test_two_no_identity_entries_returns_last_one_graceful(self):
        """둘 다 신원 부재 → 마지막 entry 반환 (graceful — 신원 박힌 후보 부재 시).

        모두 신원 부재면 fallback으로 마지막 entry. 적어도 source는 보존 → enrichment 헬퍼가
        source로 분기 가능.
        """
        metadata = [
            {"type": "caller_info", "value": {"source": "browser", "ip": "1.1.1.1"}},
            {"type": "caller_info", "value": {"source": "browser", "ip": "2.2.2.2"}},
        ]
        result = extract_caller_info_from_metadata(metadata)
        assert result == {"source": "browser", "ip": "2.2.2.2"}

    def test_identity_then_no_identity_returns_last_identity(self):
        """신원 박힌 entry 후 신원 부재 entry → *신원 박힌* entry 반환 (마지막 신원 우선).

        실용적으로 발생 가능성 낮지만 (downgrade 패턴), append-only ledger의 *current caller*
        의미를 유지하려면 신원 박힌 entry가 우선. 후속 신원 부재 entry는 부분 정보로 간주.
        """
        metadata = [
            {"type": "caller_info", "value": {
                "source": "agent",
                "display_name": "Shay",
                "agent_id": "shay",
            }},
            {"type": "caller_info", "value": {"source": "browser"}},
        ]
        result = extract_caller_info_from_metadata(metadata)
        assert result["display_name"] == "Shay"
        assert result["source"] == "agent"

    def test_three_entries_skip_non_caller_info_types(self):
        """다른 type entries(예: away_summary) 무시하고 caller_info만 검사."""
        metadata = [
            {"type": "caller_info", "value": {"source": "slack"}},
            {"type": "away_summary", "value": "..."},
            {"type": "caller_info", "value": {
                "source": "slack",
                "display_name": "スバル",
            }},
        ]
        result = extract_caller_info_from_metadata(metadata)
        assert result["display_name"] == "スバル"

    def test_invalid_entry_value_skipped(self):
        """value가 dict 아닌 caller_info entry는 무시 (graceful)."""
        metadata = [
            {"type": "caller_info", "value": {"source": "slack", "display_name": "Real"}},
            {"type": "caller_info", "value": "not-a-dict"},
            {"type": "caller_info", "value": None},
        ]
        result = extract_caller_info_from_metadata(metadata)
        assert result["display_name"] == "Real"

    def test_identity_bearing_source_only_returned(self):
        """source ∈ IDENTITY_BEARING_SOURCES이면 신원 필드 부재여도 *신원 박힌* 것으로 취급
        (`_has_identity`와 §9 대칭, R-4 atom G-13).

        agent/system/slack/soul-app/channel_observer/trello_watcher/llm 7 원소가 정체성 명시 source.
        """
        metadata = [
            {"type": "caller_info", "value": {"source": "browser", "ip": "1.1.1.1"}},
            {"type": "caller_info", "value": {"source": "agent"}},
        ]
        result = extract_caller_info_from_metadata(metadata)
        # source=agent가 신원 박힌 것으로 취급되어 우선
        assert result == {"source": "agent"}
