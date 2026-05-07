"""PushNotifier listener 시뮬레이션.

NodeManager listener 시그니처 (event_type, node_id, data)와 정규화된 이벤트 이름
("node_session_session_updated", "node_session_input_request", "node_unregistered")로
직접 호출하여 status cache·cleanup·email skip·invalid_token cleanup을 검증한다.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from soulstream_server.push.notifier import PushNotifier
from soulstream_server.push.provider import SendResult


def _make_node_manager(user_info: dict | None = None):
    nm = SimpleNamespace()
    nm.add_change_listener = lambda cb: None  # start()에서 호출만 — 검증 불필요
    nm.get_user_info = lambda node_id: user_info or {}
    return nm


def _make_notifier(
    *,
    provider=None,
    repo=None,
    user_info: dict | None = None,
):
    p = provider or AsyncMock()
    r = repo or AsyncMock()
    nm = _make_node_manager(user_info=user_info)
    return PushNotifier(provider=p, repo=r, node_manager=nm), p, r


def _data(**overrides) -> dict:
    """기본 wire payload — push 화이트리스트 게이트 통과 (claude + slack).

    LLM·비-사용자 게이트는 별도 _FILTER_MATRIX 테스트에서 검증한다.
    여기서는 게이트 외 동작(status cache, body fallback, fan-out 등)을
    검증하기 위한 baseline.
    """
    base = {"session_type": "claude", "caller_source": "slack"}
    base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_running_to_completed_emits_one_push():
    notifier, provider, repo = _make_notifier(user_info={"email": "a@b.com"})
    repo.list_tokens.return_value = [("dev-1", "tok-1")]
    provider.send.return_value = SendResult(ok=True, invalid_token=False)

    # running 진입
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(agentSessionId="S1", status="running"),
    )
    # → completed 전환
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(agentSessionId="S1", status="completed"),
    )

    # provider.send가 정확히 1회 호출되어야 한다 (running 상태에선 발사 안 함).
    assert provider.send.await_count == 1
    args = provider.send.await_args.args
    assert args[0] == "tok-1"  # token
    assert args[1] == "세션 완료"  # title
    repo.delete_token.assert_not_awaited()


@pytest.mark.asyncio
async def test_running_to_error_emits_one_push():
    notifier, provider, repo = _make_notifier(user_info={"email": "a@b.com"})
    repo.list_tokens.return_value = [("dev-1", "tok-1")]
    provider.send.return_value = SendResult(ok=True, invalid_token=False)

    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(agentSessionId="S1", status="running"),
    )
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(agentSessionId="S1", status="error"),
    )

    assert provider.send.await_count == 1
    assert provider.send.await_args.args[1] == "세션 오류"


@pytest.mark.asyncio
async def test_completed_repeated_does_not_double_fire():
    """status cache가 동일 status 재전달을 차단."""
    notifier, provider, repo = _make_notifier(user_info={"email": "a@b.com"})
    repo.list_tokens.return_value = [("dev-1", "tok-1")]
    provider.send.return_value = SendResult(ok=True, invalid_token=False)

    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(agentSessionId="S1", status="running"),
    )
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(agentSessionId="S1", status="completed"),
    )
    # 같은 status 재전달
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(agentSessionId="S1", status="completed"),
    )

    assert provider.send.await_count == 1


@pytest.mark.asyncio
async def test_input_request_emits_push():
    notifier, provider, repo = _make_notifier(user_info={"email": "a@b.com"})
    repo.list_tokens.return_value = [("dev-1", "tok-1")]
    provider.send.return_value = SendResult(ok=True, invalid_token=False)

    await notifier._on_change(
        "node_session_input_request",
        "node-A",
        _data(agentSessionId="S1", prompt="Continue?"),
    )

    assert provider.send.await_count == 1
    assert provider.send.await_args.args[1] == "입력 요청"
    assert provider.send.await_args.args[2] == "Continue?"


@pytest.mark.asyncio
async def test_invalid_token_triggers_cleanup():
    notifier, provider, repo = _make_notifier(user_info={"email": "a@b.com"})
    repo.list_tokens.return_value = [("dev-1", "tok-1")]
    provider.send.return_value = SendResult(ok=False, invalid_token=True, error="DeviceNotRegistered")

    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(agentSessionId="S1", status="running"),
    )
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(agentSessionId="S1", status="completed"),
    )

    repo.delete_token.assert_awaited_once_with("a@b.com", "dev-1")


@pytest.mark.asyncio
async def test_node_unregistered_clears_cache():
    notifier, provider, repo = _make_notifier(user_info={"email": "a@b.com"})
    repo.list_tokens.return_value = [("dev-1", "tok-1")]
    provider.send.return_value = SendResult(ok=True, invalid_token=False)

    # running 상태 캐시
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(agentSessionId="S1", status="running"),
    )
    await notifier._on_change(
        "node_session_session_updated",
        "node-B",
        _data(agentSessionId="S2", status="running"),
    )
    assert ("node-A", "S1") in notifier._last_status
    assert ("node-B", "S2") in notifier._last_status

    # node-A unregister
    await notifier._on_change("node_unregistered", "node-A", None)

    # node-A 항목만 정리되고 node-B는 남는다
    assert ("node-A", "S1") not in notifier._last_status
    assert ("node-B", "S2") in notifier._last_status


@pytest.mark.asyncio
async def test_skip_when_email_missing():
    """user_info가 빈 dict이면 push 발송하지 않음 (silent skip)."""
    notifier, provider, repo = _make_notifier(user_info={})  # email 없음
    repo.list_tokens.return_value = [("dev-1", "tok-1")]

    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(agentSessionId="S1", status="running"),
    )
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(agentSessionId="S1", status="completed"),
    )

    provider.send.assert_not_awaited()
    repo.list_tokens.assert_not_awaited()


@pytest.mark.asyncio
async def test_no_tokens_skips_send():
    """등록된 토큰이 없으면 provider.send 호출 안 함."""
    notifier, provider, repo = _make_notifier(user_info={"email": "a@b.com"})
    repo.list_tokens.return_value = []

    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(agentSessionId="S1", status="running"),
    )
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(agentSessionId="S1", status="completed"),
    )

    provider.send.assert_not_awaited()


@pytest.mark.asyncio
async def test_multiple_devices_fan_out():
    notifier, provider, repo = _make_notifier(user_info={"email": "a@b.com"})
    repo.list_tokens.return_value = [
        ("dev-1", "tok-1"),
        ("dev-2", "tok-2"),
        ("dev-3", "tok-3"),
    ]
    provider.send.return_value = SendResult(ok=True, invalid_token=False)

    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(agentSessionId="S1", status="running"),
    )
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(agentSessionId="S1", status="completed"),
    )

    # 3개 디바이스 모두에 발송 (사용자 단위 fan-out)
    assert provider.send.await_count == 3


@pytest.mark.asyncio
async def test_session_updated_with_snake_case_agent_session_id():
    """🔴 회귀 방지: soul-server emit_session_updated/emit_session_phase는
    `agent_session_id` (snake_case) 키를 사용한다 (session_broadcaster.py:72,94).
    PushNotifier가 camelCase만 찾으면 session_id가 None이 되어 silent skip된다."""
    notifier, provider, repo = _make_notifier(user_info={"email": "a@b.com"})
    repo.list_tokens.return_value = [("dev-1", "tok-1")]
    provider.send.return_value = SendResult(ok=True, invalid_token=False)

    # snake_case 키만 사용 (실제 wire format)
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(agent_session_id="S1", status="running"),
    )
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(agent_session_id="S1", status="completed"),
    )

    assert provider.send.await_count == 1
    assert provider.send.await_args.args[1] == "세션 완료"


@pytest.mark.asyncio
async def test_input_request_with_snake_case_agent_session_id():
    """🔴 회귀 방지: input_request도 동일하게 snake_case를 받아야 한다."""
    notifier, provider, repo = _make_notifier(user_info={"email": "a@b.com"})
    repo.list_tokens.return_value = [("dev-1", "tok-1")]
    provider.send.return_value = SendResult(ok=True, invalid_token=False)

    await notifier._on_change(
        "node_session_input_request",
        "node-A",
        _data(agent_session_id="S1", prompt="어떻게 진행할까요?"),
    )

    assert provider.send.await_count == 1
    assert provider.send.await_args.args[1] == "입력 요청"


@pytest.mark.asyncio
async def test_completed_body_uses_last_progress_text():
    """🔴 회귀 방지: push body는 session_id가 아니라 마지막 어시스턴트 응답
    텍스트(last_progress_text)를 사용한다. 사용자 보고 — body에 session_id[:8]이
    노출되던 결함."""
    notifier, provider, repo = _make_notifier(user_info={"email": "a@b.com"})
    repo.list_tokens.return_value = [("dev-1", "tok-1")]
    provider.send.return_value = SendResult(ok=True, invalid_token=False)

    last_text = "네, 트렐로 카드를 새로 만들고 체크리스트를 정리했사옵니다."
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(agent_session_id="S1", status="running"),
    )
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(
            agent_session_id="S1",
            status="completed",
            last_progress_text=last_text,
        ),
    )

    assert provider.send.await_count == 1
    args = provider.send.await_args.args
    assert args[1] == "세션 완료"
    assert args[2] == last_text
    assert "S1" not in args[2]


@pytest.mark.asyncio
async def test_completed_body_truncates_long_text():
    """본문이 100자 초과면 절단되고 '…'가 붙는다."""
    notifier, provider, repo = _make_notifier(user_info={"email": "a@b.com"})
    repo.list_tokens.return_value = [("dev-1", "tok-1")]
    provider.send.return_value = SendResult(ok=True, invalid_token=False)

    long_text = "가" * 200
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(agent_session_id="S1", status="running"),
    )
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(
            agent_session_id="S1",
            status="completed",
            last_progress_text=long_text,
        ),
    )

    body = provider.send.await_args.args[2]
    assert body.endswith("…")
    assert len(body) <= 102


@pytest.mark.asyncio
async def test_completed_body_falls_back_to_title():
    """last_progress_text·last_message·display_name 모두 없으면 title을 본문으로."""
    notifier, provider, repo = _make_notifier(user_info={"email": "a@b.com"})
    repo.list_tokens.return_value = [("dev-1", "tok-1")]
    provider.send.return_value = SendResult(ok=True, invalid_token=False)

    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(agent_session_id="S1", status="running"),
    )
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(agent_session_id="S1", status="completed"),
    )

    body = provider.send.await_args.args[2]
    assert body == "세션 완료"


@pytest.mark.asyncio
async def test_completed_body_prefers_last_assistant_text_over_progress():
    """🔴 회귀 방지: last_assistant_text가 있으면 그것을 1순위로 사용한다.
    last_progress_text('도구 실행 중...' 같은 진행 안내)가 본문에 들어가던 결함 회피.
    사용자 보고: '메시지가 어시스턴트 응답으로 시작해야 하는데 [PHASE]…' 같은 단편이 와버림."""
    notifier, provider, repo = _make_notifier(user_info={"email": "a@b.com"})
    repo.list_tokens.return_value = [("dev-1", "tok-1")]
    provider.send.return_value = SendResult(ok=True, invalid_token=False)

    assistant_text = "네, 트렐로 카드를 새로 만들고 체크리스트를 정리했사옵니다."
    progress_text = "도구 실행 중…"
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(agent_session_id="S1", status="running"),
    )
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(
            agent_session_id="S1",
            status="completed",
            last_assistant_text=assistant_text,
            last_progress_text=progress_text,
        ),
    )

    body = provider.send.await_args.args[2]
    assert body == assistant_text
    assert progress_text not in body


@pytest.mark.asyncio
async def test_completed_body_progress_text_only_when_assistant_missing():
    """last_assistant_text가 없을 때만 last_progress_text를 fallback으로 사용."""
    notifier, provider, repo = _make_notifier(user_info={"email": "a@b.com"})
    repo.list_tokens.return_value = [("dev-1", "tok-1")]
    provider.send.return_value = SendResult(ok=True, invalid_token=False)

    progress_text = "응답 생성 중..."
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(agent_session_id="S1", status="running"),
    )
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        _data(
            agent_session_id="S1",
            status="completed",
            last_progress_text=progress_text,
        ),
    )

    body = provider.send.await_args.args[2]
    assert body == progress_text


# ─────────────────────────────────────────────────────────────────────────────
# session_type / caller_source 화이트리스트 게이트 (LLM·비-사용자 시작 세션 차단)
#
# session_broadcaster.emit_session_updated / emit_session_phase 가 wire에 싣는
# `session_type`, `caller_source` 메타를 PushNotifier가 게이트로 사용한다.
# - session_type == "llm" → 차단
# - caller_source ∉ {slack, browser, soul-app} → 차단
# 통과 케이스는 push data dict에도 sessionType / callerSource를 전파한다.
# ─────────────────────────────────────────────────────────────────────────────


# (case_id, session_type, caller_source, expect_send_count)
# expect_send_count == 1 → push 송출 (통과 화이트리스트)
# expect_send_count == 0 → 차단
_FILTER_MATRIX = [
    ("llm_browser_blocked",           "llm",    "browser",            0),
    ("claude_channel_observer",       "claude", "channel_observer",   0),
    ("claude_trello_watcher",         "claude", "trello_watcher",     0),
    ("claude_agent",                  "claude", "agent",              0),
    ("claude_caller_source_none",     "claude", None,                 0),
    ("claude_slack_passes",           "claude", "slack",              1),
    ("claude_browser_passes",         "claude", "browser",            1),
    ("claude_soul_app_passes",        "claude", "soul-app",           1),
]


@pytest.mark.parametrize(
    "case_id,session_type,caller_source,expect_count",
    _FILTER_MATRIX,
    ids=[c[0] for c in _FILTER_MATRIX],
)
@pytest.mark.asyncio
async def test_session_updated_filter_matrix(
    case_id, session_type, caller_source, expect_count
):
    """_handle_session_updated 게이트 — 8케이스."""
    notifier, provider, repo = _make_notifier(user_info={"email": "a@b.com"})
    repo.list_tokens.return_value = [("dev-1", "tok-1")]
    provider.send.return_value = SendResult(ok=True, invalid_token=False)

    base = {
        "agent_session_id": "S1",
        "session_type": session_type,
        "caller_source": caller_source,
    }
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        {**base, "status": "running"},
    )
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        {**base, "status": "completed"},
    )

    assert provider.send.await_count == expect_count, (
        f"{case_id}: expected {expect_count} push send(s), got {provider.send.await_count}"
    )

    if expect_count == 1:
        # 통과 케이스 — push data dict에 sessionType / callerSource가 포함되어야 한다
        # (provider.send 시그니처: token, title, body, data)
        data_arg = provider.send.await_args.args[3]
        assert data_arg["sessionId"] == "S1"
        assert data_arg["status"] == "completed"
        assert data_arg["sessionType"] == session_type
        assert data_arg["callerSource"] == caller_source


@pytest.mark.parametrize(
    "case_id,session_type,caller_source,expect_count",
    _FILTER_MATRIX,
    ids=[c[0] for c in _FILTER_MATRIX],
)
@pytest.mark.asyncio
async def test_input_request_filter_matrix(
    case_id, session_type, caller_source, expect_count
):
    """_handle_input_request 게이트 — 8케이스 (대칭)."""
    notifier, provider, repo = _make_notifier(user_info={"email": "a@b.com"})
    repo.list_tokens.return_value = [("dev-1", "tok-1")]
    provider.send.return_value = SendResult(ok=True, invalid_token=False)

    await notifier._on_change(
        "node_session_input_request",
        "node-A",
        {
            "agent_session_id": "S1",
            "prompt": "Continue?",
            "session_type": session_type,
            "caller_source": caller_source,
        },
    )

    assert provider.send.await_count == expect_count, (
        f"{case_id}: expected {expect_count} push send(s), got {provider.send.await_count}"
    )

    if expect_count == 1:
        data_arg = provider.send.await_args.args[3]
        assert data_arg["sessionId"] == "S1"
        assert data_arg["kind"] == "input_request"
        assert data_arg["sessionType"] == session_type
        assert data_arg["callerSource"] == caller_source


# === 통합 caller_info 스키마 v1 회귀 보호 (2026-05-07 Phase 5) ===
#
# Phase 2a/3에서 caller_info에 추가된 v1 top-level 필드(display_name, user_id,
# avatar_url, email)는 wire payload(emit_session_updated/phase의 9키 정본 — atom
# 901f8109 참조)에 노출되지 않는다. 따라서 push notifier 화이트리스트는 본 변경의
# 영향을 받지 않아야 한다. 본 테스트는 회귀 방지를 위해 wire data에 v1 키가 우연히
# 끼어들어도 화이트리스트가 caller_source만 보고 정상 동작함을 명시 검증.


@pytest.mark.asyncio
async def test_push_unaffected_by_v1_caller_info_extra_keys():
    """v1 caller_info 필드가 wire data에 끼어들어도 push 동작 무영향.

    event_type은 input_request로 검증 — input_request는 status 전환 없이 단발 알림이라
    화이트리스트 통과 여부만 격리하여 측정 가능.
    """
    notifier, provider, repo = _make_notifier(user_info={"email": "a@b.com"})
    repo.list_tokens.return_value = [("dev-1", "tok-1")]
    provider.send.return_value = SendResult(ok=True, invalid_token=False)

    await notifier._on_change(
        "node_session_input_request",
        "node-A",
        {
            "agent_session_id": "S1",
            "prompt": "Continue?",
            "session_type": "claude",
            "caller_source": "browser",
            # v1 추가 필드 — 실제 wire에는 없지만 방어적 회귀 검증
            "display_name": "서소영",
            "user_id": "user@example.com",
            "avatar_url": "https://example.com/avatar.png",
            "email": "user@example.com",
        },
    )
    assert provider.send.await_count == 1
    data_arg = provider.send.await_args.args[3]
    assert data_arg["sessionId"] == "S1"
    assert data_arg["callerSource"] == "browser"


@pytest.mark.asyncio
async def test_whitelist_unchanged_after_v1_introduction():
    """v1 도입 후에도 화이트리스트는 ('slack', 'browser', 'soul-app') 그대로.
    'agent'/'api'는 silent skip 유지 (atom a3d3c812 정본 보존)."""
    notifier, provider, repo = _make_notifier(user_info={"email": "a@b.com"})
    repo.list_tokens.return_value = [("dev-1", "tok-1")]
    provider.send.return_value = SendResult(ok=True, invalid_token=False)

    for excluded_source in ("agent", "api"):
        provider.send.reset_mock()
        await notifier._on_change(
            "node_session_input_request",
            "node-A",
            {
                "agent_session_id": "S2",
                "prompt": "Continue?",
                "session_type": "claude",
                "caller_source": excluded_source,
                "display_name": "Test",  # v1 필드 무관
            },
        )
        assert provider.send.await_count == 0, (
            f"caller_source={excluded_source!r}는 silent skip이어야 함"
        )
