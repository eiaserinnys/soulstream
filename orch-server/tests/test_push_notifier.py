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


@pytest.mark.asyncio
async def test_running_to_completed_emits_one_push():
    notifier, provider, repo = _make_notifier(user_info={"email": "a@b.com"})
    repo.list_tokens.return_value = [("dev-1", "tok-1")]
    provider.send.return_value = SendResult(ok=True, invalid_token=False)

    # running 진입
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        {"agentSessionId": "S1", "status": "running"},
    )
    # → completed 전환
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        {"agentSessionId": "S1", "status": "completed"},
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
        {"agentSessionId": "S1", "status": "running"},
    )
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        {"agentSessionId": "S1", "status": "error"},
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
        {"agentSessionId": "S1", "status": "running"},
    )
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        {"agentSessionId": "S1", "status": "completed"},
    )
    # 같은 status 재전달
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        {"agentSessionId": "S1", "status": "completed"},
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
        {"agentSessionId": "S1", "prompt": "Continue?"},
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
        {"agentSessionId": "S1", "status": "running"},
    )
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        {"agentSessionId": "S1", "status": "completed"},
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
        {"agentSessionId": "S1", "status": "running"},
    )
    await notifier._on_change(
        "node_session_session_updated",
        "node-B",
        {"agentSessionId": "S2", "status": "running"},
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
        {"agentSessionId": "S1", "status": "running"},
    )
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        {"agentSessionId": "S1", "status": "completed"},
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
        {"agentSessionId": "S1", "status": "running"},
    )
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        {"agentSessionId": "S1", "status": "completed"},
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
        {"agentSessionId": "S1", "status": "running"},
    )
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        {"agentSessionId": "S1", "status": "completed"},
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
        {"agent_session_id": "S1", "status": "running"},
    )
    await notifier._on_change(
        "node_session_session_updated",
        "node-A",
        {"agent_session_id": "S1", "status": "completed"},
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
        {"agent_session_id": "S1", "prompt": "어떻게 진행할까요?"},
    )

    assert provider.send.await_count == 1
    assert provider.send.await_args.args[1] == "입력 요청"
