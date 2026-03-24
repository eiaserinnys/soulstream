"""Tests for Sessions SSE stream (/api/sessions/stream).

Validates the SSE endpoint that the soul-ui useSessionListProvider expects:
- Initial session_list event on connect
- Relays broadcaster events (session_created, session_deleted, etc.)
"""

import asyncio
import json

import pytest

from soulstream_server.api.sessions import _session_to_response
from soulstream_server.service.session_broadcaster import SessionBroadcaster


class TestSessionToResponseFormat:
    """_session_to_response output matches what session_list SSE sends."""

    async def test_response_has_camelcase_fields(self):
        """Converted session has camelCase field names."""
        session = {
            "session_id": "s1",
            "status": "running",
            "prompt": "hello",
            "created_at": "2026-01-01T00:00:00",
            "updated_at": None,
            "session_type": "claude",
            "last_message": "test msg",
            "client_id": "c1",
            "metadata": None,
            "display_name": "My Session",
            "node_id": "n1",
            "folder_id": "f1",
        }

        result = _session_to_response(session)

        assert result["agentSessionId"] == "s1"
        assert result["status"] == "running"
        assert result["prompt"] == "hello"
        assert result["createdAt"] == "2026-01-01T00:00:00"
        assert result["updatedAt"] is None
        assert result["sessionType"] == "claude"
        assert result["lastMessage"] == "test msg"
        assert result["clientId"] == "c1"
        assert result["displayName"] == "My Session"
        assert result["nodeId"] == "n1"
        assert result["folderId"] == "f1"

    async def test_datetime_objects_converted_to_isoformat(self):
        """datetime objects in created_at/updated_at are converted to ISO strings."""
        from datetime import datetime, timezone

        now = datetime(2026, 3, 25, 12, 0, 0, tzinfo=timezone.utc)
        session = {
            "session_id": "s1",
            "status": "running",
            "created_at": now,
            "updated_at": now,
        }

        result = _session_to_response(session)
        assert result["createdAt"] == "2026-03-25T12:00:00+00:00"
        assert result["updatedAt"] == "2026-03-25T12:00:00+00:00"


class TestSessionStreamBroadcasterIntegration:
    """Broadcaster events are relayed through the sessions stream."""

    async def test_add_client_registers_queue(self):
        """add_client() adds a queue to the broadcaster."""
        broadcaster = SessionBroadcaster()

        queue = broadcaster.add_client()

        await broadcaster.broadcast({"type": "session_created", "session": {}})
        event = queue.get_nowait()
        assert event["type"] == "session_created"

        broadcaster.remove_client(queue)

    async def test_session_deleted_event_format(self):
        """session_deleted events have the expected format."""
        broadcaster = SessionBroadcaster()
        queue = broadcaster.add_client()

        await broadcaster.emit_session_deleted("sess-42")

        event = queue.get_nowait()
        assert event["type"] == "session_deleted"
        assert event["agent_session_id"] == "sess-42"

        broadcaster.remove_client(queue)

    async def test_session_list_change_event(self):
        """broadcast_session_list_change relays arbitrary change events."""
        broadcaster = SessionBroadcaster()
        queue = broadcaster.add_client()

        await broadcaster.broadcast_session_list_change({
            "type": "session_updated",
            "agent_session_id": "s1",
            "status": "completed",
        })

        event = queue.get_nowait()
        assert event["type"] == "session_updated"
        assert event["agent_session_id"] == "s1"

        broadcaster.remove_client(queue)

    async def test_remove_client_is_safe_for_unknown_queue(self):
        """remove_client() doesn't raise for an unregistered queue."""
        broadcaster = SessionBroadcaster()
        unknown_queue: asyncio.Queue[dict | None] = asyncio.Queue()
        # Should not raise
        broadcaster.remove_client(unknown_queue)
