"""Folder metadata forwarding for response-wait push signals."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from soulstream_server.constants import EVT_EVENT
from soulstream_server.nodes.inbound_events import NodeInboundEvents


@pytest.mark.asyncio
async def test_response_wait_signal_includes_cached_folder_id():
    on_session_change = AsyncMock()
    inbound = NodeInboundEvents(
        node_id="node-1",
        on_session_change=on_session_change,
    )
    inbound.sessions["sess-folder"] = {
        "agentSessionId": "sess-folder",
        "prompt": "Hidden folder session",
        "session_type": "claude",
        "caller_source": "browser",
        "folder_id": "folder-hidden",
        "folderId": "folder-hidden",
    }

    await inbound.handle(
        {
            "type": EVT_EVENT,
            "agentSessionId": "sess-folder",
            "event": {
                "type": "input_request",
                "request_id": "req-folder",
                "questions": [{"question": "Continue?", "options": []}],
            },
        }
    )

    on_session_change.assert_awaited_once()
    payload = on_session_change.await_args.args[2]
    assert payload["folder_id"] == "folder-hidden"
    assert payload["folderId"] == "folder-hidden"
