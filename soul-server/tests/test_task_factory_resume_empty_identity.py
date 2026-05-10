"""test_task_factory_resume_empty_identity — R-2 resume `_has_identity` 가드 회귀.

R-2 fix(2026-05-10) — atom 0d366900 (G-3):
- `task_factory._has_identity`가 정체성 명시 source(agent/system/slack/soul-app)이거나
  display_name/avatar_url truthy일 때만 True 반환.
- `_resume_existing_task_locked`(L199-200)에서 빈 신원 caller_info가 이전의 정상
  caller_info를 덮어쓰지 않게 가드.

매트릭스:
- T-G3-A: browser + 신원 부재 → 보존 (인증 안 된 resume race)
- T-G3-B: browser + 신원 truthy → 갱신 (인증된 browser resume)
- T-G3-C: caller_info=None → 보존 (graceful — 외부 호출자 의도 없음)
- T-G3-D: slack + 신원 부재 → 갱신 (정체성 명시 source)
- T-G3-E: agent + 신원 부재 → 갱신 (정체성 명시 source)
"""
from soul_server.service.task_factory import _has_identity


class TestHasIdentityGuard:
    """`_has_identity` 모듈 함수 단위 매트릭스."""

    def test_agent_source_only_returns_true(self):
        """T-G3-E: agent source만 있어도 True (정체성 명시)."""
        assert _has_identity({"source": "agent"}) is True

    def test_system_source_only_returns_true(self):
        """system source만 있어도 True."""
        assert _has_identity({"source": "system"}) is True

    def test_slack_source_only_returns_true(self):
        """T-G3-D: slack source만 있어도 True (atom 1e71e0d8 N.1 full identity)."""
        assert _has_identity({"source": "slack"}) is True

    def test_soul_app_source_only_returns_true(self):
        """soul-app source만 있어도 True (본인 picture 정체성)."""
        assert _has_identity({"source": "soul-app"}) is True

    def test_browser_source_only_returns_false(self):
        """T-G3-A 핵심: browser source만 있고 신원 부재 → False (빈 신원)."""
        assert _has_identity({"source": "browser"}) is False

    def test_browser_with_display_name_returns_true(self):
        """T-G3-B: browser source + display_name truthy → True (인증된 browser)."""
        assert _has_identity({"source": "browser", "display_name": "Eias"}) is True

    def test_browser_with_avatar_only_returns_true(self):
        """browser source + avatar_url만 truthy → True (부분 정체성)."""
        assert _has_identity({"source": "browser", "avatar_url": "https://x.test/p"}) is True

    def test_api_source_only_returns_false(self):
        """api source (HTTP 메타 fallback) + 신원 부재 → False."""
        assert _has_identity({"source": "api"}) is False

    def test_no_source_with_identity_returns_true(self):
        """source 부재이지만 신원 필드 truthy → True (부분 정체성)."""
        assert _has_identity({"display_name": "Anonymous"}) is True

    def test_empty_dict_returns_false(self):
        """완전 빈 dict → False."""
        assert _has_identity({}) is False

    def test_browser_with_ip_only_returns_false(self):
        """browser source + HTTP 메타(ip 등)만 — 신원 필드 부재 → False (G-3 핵심 케이스)."""
        assert _has_identity({
            "source": "browser",
            "ip": "127.0.0.1",
            "user_agent": "Mozilla/5.0",
        }) is False

    def test_unknown_source_with_identity_returns_true(self):
        """알 수 없는 source라도 신원 필드 truthy → True."""
        assert _has_identity({"source": "channel_observer", "display_name": "Observer"}) is True

    def test_unknown_source_without_identity_returns_false(self):
        """알 수 없는 source + 신원 부재 → False."""
        assert _has_identity({"source": "channel_observer"}) is False
