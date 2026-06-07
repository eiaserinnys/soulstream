"""Folder notification settings gate for PushNotifier."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from soulstream_server.push.notifier import PushNotifier
from soulstream_server.push.provider import SendResult


def _node_manager():
    nm = SimpleNamespace()
    nm.add_change_listener = lambda cb: None
    nm.get_user_info = lambda node_id: {"email": "a@b.com"}
    return nm


def _catalog_service(*, excluded: bool | None = True, fail: bool = False):
    catalog = AsyncMock()
    if fail:
        catalog.list_session_assignments.side_effect = RuntimeError("catalog down")
    else:
        catalog.list_session_assignments.return_value = {
            "S1": {"folderId": "f-hidden", "displayName": None}
        }
    settings = {}
    if excluded is not None:
        settings["excludeFromNotification"] = excluded
    catalog.list_folders.return_value = [
        {
            "id": "f-hidden",
            "name": "Hidden",
            "sortOrder": 0,
            "settings": settings,
        }
    ]
    return catalog


def _notifier(*, catalog_service):
    provider = AsyncMock()
    repo = AsyncMock()
    repo.list_tokens.return_value = [("dev-1", "tok-1")]
    provider.send.return_value = SendResult(ok=True, invalid_token=False)
    return (
        PushNotifier(
            provider=provider,
            repo=repo,
            node_manager=_node_manager(),
            catalog_service=catalog_service,
        ),
        provider,
        repo,
    )


def _data(**overrides) -> dict:
    data = {"session_type": "claude", "caller_source": "slack"}
    data.update(overrides)
    return data


@pytest.mark.asyncio
async def test_completion_push_skips_when_folder_excludes_notifications():
    notifier, provider, repo = _notifier(
        catalog_service=_catalog_service(excluded=True)
    )

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
async def test_input_request_push_skips_when_folder_excludes_notifications():
    notifier, provider, repo = _notifier(
        catalog_service=_catalog_service(excluded=True)
    )

    await notifier._on_change(
        "node_session_input_request",
        "node-A",
        _data(agentSessionId="S1", prompt="Continue?"),
    )

    provider.send.assert_not_awaited()
    repo.list_tokens.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("excluded", [False, None])
async def test_push_still_sends_when_notification_setting_is_unset_or_false(
    excluded,
):
    notifier, provider, _repo = _notifier(
        catalog_service=_catalog_service(excluded=excluded)
    )

    await notifier._on_change(
        "node_session_input_request",
        "node-A",
        _data(agentSessionId="S1", prompt="Continue?"),
    )

    assert provider.send.await_count == 1


@pytest.mark.asyncio
async def test_push_still_sends_when_catalog_lookup_fails():
    notifier, provider, _repo = _notifier(
        catalog_service=_catalog_service(fail=True)
    )

    await notifier._on_change(
        "node_session_input_request",
        "node-A",
        _data(agentSessionId="S1", prompt="Continue?"),
    )

    assert provider.send.await_count == 1
