"""test_dash_user_profile - dashboard user 프로필 enrichment 헬퍼 단위 테스트.

R-3 fix(2026-05-08): orch `apply_user_profile_enrichment`(session_serializer.py)와
*동일 의미*의 정책을 soul-server 자체 대시보드에서 따른다. 정본 둘 안티패턴
(atom d7a1ad86) 회피 — 정책 의미가 양 정본에서 동일.

매트릭스 (orch 측 회귀 테스트와 1:1 대응):
- T1 payload 비어있음 + user_name 있음 → 채움
- T2 payload userName 채움 → NOOP (caller_info 정체성 보존)
- T3 user_name None/빈 → NOOP (graceful)
- T4 payload userPortraitUrl만 채움 → NOOP (mix-fallback 금지)
- T5 user_portrait_url 빈 값 → name만 채움
- T6 키 존재하지만 값 None (wire 일관성 케이스) → 채움
"""
import pytest

from soul_server.dashboard.user_profile import apply_dash_user_profile_enrichment


class TestApplyDashUserProfileEnrichment:
    """apply_dash_user_profile_enrichment 정책 매트릭스."""

    def test_t1_empty_payload_with_user_name_fills(self):
        """T1: payload 비어있고 user_name 있음 → 채움."""
        payload = {"agent_session_id": "s1"}
        apply_dash_user_profile_enrichment(
            payload,
            user_name="Alice",
            user_portrait_url="/api/dashboard/portrait/user",
        )
        assert payload["userName"] == "Alice"
        assert payload["userPortraitUrl"] == "/api/dashboard/portrait/user"

    def test_t1b_payload_with_none_keys_fills(self):
        """T1': payload에 키 존재하지만 값 None (wire 일관성 케이스) → 채움."""
        payload = {"userName": None, "userPortraitUrl": None}
        apply_dash_user_profile_enrichment(
            payload,
            user_name="Alice",
            user_portrait_url="/api/dashboard/portrait/user",
        )
        assert payload["userName"] == "Alice"
        assert payload["userPortraitUrl"] == "/api/dashboard/portrait/user"

    def test_t2_caller_info_name_preserved(self):
        """T2: payload에 caller_info userName 채워짐 → NOOP (정체성 보존)."""
        payload = {"userName": "Bob", "userPortraitUrl": None}
        apply_dash_user_profile_enrichment(
            payload,
            user_name="Alice",
            user_portrait_url="/api/dashboard/portrait/user",
        )
        # mix-fallback 금지 — userName이 truthy이면 portrait도 덮지 않음
        assert payload["userName"] == "Bob"
        assert payload["userPortraitUrl"] is None

    def test_t3_user_name_none_noop(self):
        """T3: user_name None → NOOP (graceful)."""
        payload = {"userName": None, "userPortraitUrl": None}
        apply_dash_user_profile_enrichment(
            payload,
            user_name=None,
            user_portrait_url="/api/dashboard/portrait/user",
        )
        assert payload["userName"] is None
        assert payload["userPortraitUrl"] is None

    def test_t3b_user_name_empty_string_noop(self):
        """T3': user_name 빈 문자열 → NOOP."""
        payload = {"userName": None}
        apply_dash_user_profile_enrichment(
            payload,
            user_name="",
            user_portrait_url=None,
        )
        assert payload["userName"] is None

    def test_t4_caller_info_portrait_only_preserved(self):
        """T4: payload에 userPortraitUrl만 채워짐 → NOOP (mix-fallback 금지)."""
        payload = {"userName": None, "userPortraitUrl": "https://avatars.slack.com/u123"}
        apply_dash_user_profile_enrichment(
            payload,
            user_name="Alice",
            user_portrait_url="/api/dashboard/portrait/user",
        )
        # caller_info 정체성 부분이라도 있으면 보존
        assert payload["userName"] is None
        assert payload["userPortraitUrl"] == "https://avatars.slack.com/u123"

    def test_t5_user_portrait_empty_name_only_filled(self):
        """T5: user_portrait_url 빈 값 → name만 채움 (portrait는 None 유지)."""
        payload = {"userName": None, "userPortraitUrl": None}
        apply_dash_user_profile_enrichment(
            payload,
            user_name="Alice",
            user_portrait_url=None,
        )
        assert payload["userName"] == "Alice"
        assert payload["userPortraitUrl"] is None

    def test_custom_keys(self):
        """name_key/portrait_key를 다른 이름으로 지정 가능."""
        payload = {"display": None, "avatar": None}
        apply_dash_user_profile_enrichment(
            payload,
            user_name="Alice",
            user_portrait_url="/x/y",
            name_key="display",
            portrait_key="avatar",
        )
        assert payload["display"] == "Alice"
        assert payload["avatar"] == "/x/y"

    def test_in_place_returns_none(self):
        """in-place 수정, 반환 None — orch 헬퍼와 동일 시그니처."""
        payload = {"userName": None}
        result = apply_dash_user_profile_enrichment(
            payload, user_name="Alice", user_portrait_url=None
        )
        assert result is None
        assert payload["userName"] == "Alice"
