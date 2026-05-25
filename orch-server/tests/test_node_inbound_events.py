"""Tests for inbound node event dispatch and session cache policy."""

from unittest.mock import AsyncMock

import pytest

from soulstream_server.constants import (
    EVT_ERROR,
    EVT_EVENT,
    EVT_HEALTH_STATUS,
    EVT_INPUT_REQUEST,
    EVT_SESSION_CREATED,
    EVT_SESSION_DELETED,
    EVT_SESSION_UPDATED,
    EVT_SESSIONS_UPDATE,
)
from soulstream_server.nodes.inbound_events import NodeInboundEvents


@pytest.fixture
def on_session_change():
    return AsyncMock()


@pytest.fixture
def inbound(on_session_change):
    return NodeInboundEvents(
        node_id="node-1",
        on_session_change=on_session_change,
    )


class TestNodeInboundEventsSessionCache:
    async def test_session_created_updates_cache_and_reports_change(
        self, inbound, on_session_change
    ):
        data = {
            "type": EVT_SESSION_CREATED,
            "agentSessionId": "sess-new",
            "status": "idle",
        }

        await inbound.handle(data)

        assert inbound.sessions["sess-new"] == {
            "agentSessionId": "sess-new",
            "status": "idle",
            "nodeId": "node-1",
        }
        on_session_change.assert_awaited_once_with(
            "node-1", "session_created", data
        )

    @pytest.mark.parametrize(
        ("data", "session_id"),
        [
            (
                {
                    "type": EVT_SESSION_CREATED,
                    "agent_session_id": "sess-snake-top",
                    "status": "idle",
                },
                "sess-snake-top",
            ),
            (
                {
                    "type": EVT_SESSION_CREATED,
                    "session": {
                        "agentSessionId": "sess-camel-nested",
                        "status": "running",
                    },
                },
                "sess-camel-nested",
            ),
            (
                {
                    "type": EVT_SESSION_CREATED,
                    "session": {
                        "agent_session_id": "sess-snake-nested",
                        "status": "running",
                    },
                },
                "sess-snake-nested",
            ),
        ],
    )
    async def test_session_created_accepts_snake_and_nested_session_ids(
        self, inbound, on_session_change, data, session_id
    ):
        await inbound.handle(data)

        assert inbound.sessions[session_id]["agentSessionId"] == session_id
        on_session_change.assert_awaited_once_with(
            "node-1", "session_created", data
        )

    async def test_sessions_update_replaces_cache_and_reports_change(
        self, inbound, on_session_change
    ):
        inbound.sessions["old"] = {"agentSessionId": "old"}
        data = {
            "type": EVT_SESSIONS_UPDATE,
            "sessions": [
                {"agentSessionId": "new-1", "status": "running"},
                {"session_id": "new-2", "status": "idle"},
            ],
        }

        await inbound.handle(data)

        assert set(inbound.sessions) == {"new-1", "new-2"}
        assert inbound.sessions["new-1"]["status"] == "running"
        assert inbound.sessions["new-2"]["status"] == "idle"
        on_session_change.assert_awaited_once_with(
            "node-1", "sessions_update", data
        )

    async def test_sessions_update_accepts_snake_case_agent_session_id(
        self, inbound, on_session_change
    ):
        data = {
            "type": EVT_SESSIONS_UPDATE,
            "sessions": [
                {"agent_session_id": "new-snake", "status": "running"},
            ],
        }

        await inbound.handle(data)

        assert "new-snake" in inbound.sessions
        on_session_change.assert_awaited_once_with(
            "node-1", "sessions_update", data
        )

    async def test_session_updated_updates_existing_cache_item_and_reports_change(
        self, inbound, on_session_change
    ):
        inbound.sessions["sess-x"] = {
            "agentSessionId": "sess-x",
            "status": "running",
        }
        data = {
            "type": EVT_SESSION_UPDATED,
            "agentSessionId": "sess-x",
            "status": "idle",
        }

        await inbound.handle(data)

        assert inbound.sessions["sess-x"]["status"] == "idle"
        on_session_change.assert_awaited_once_with(
            "node-1", "session_updated", data
        )

    async def test_session_updated_accepts_snake_case_agent_session_id(
        self, inbound, on_session_change
    ):
        inbound.sessions["sess-snake"] = {
            "agentSessionId": "sess-snake",
            "status": "running",
        }
        data = {
            "type": EVT_SESSION_UPDATED,
            "agent_session_id": "sess-snake",
            "status": "idle",
        }

        await inbound.handle(data)

        assert inbound.sessions["sess-snake"]["status"] == "idle"
        on_session_change.assert_awaited_once_with(
            "node-1", "session_updated", data
        )

    async def test_session_updated_does_not_create_missing_cache_item(
        self, inbound, on_session_change
    ):
        data = {
            "type": EVT_SESSION_UPDATED,
            "agentSessionId": "missing",
            "status": "idle",
        }

        await inbound.handle(data)

        assert "missing" not in inbound.sessions
        on_session_change.assert_awaited_once_with(
            "node-1", "session_updated", data
        )

    async def test_session_deleted_removes_cache_item_and_reports_change(
        self, inbound, on_session_change
    ):
        inbound.sessions["sess-del"] = {"agentSessionId": "sess-del"}
        data = {
            "type": EVT_SESSION_DELETED,
            "agentSessionId": "sess-del",
        }

        await inbound.handle(data)

        assert "sess-del" not in inbound.sessions
        on_session_change.assert_awaited_once_with(
            "node-1", "session_deleted", data
        )

    async def test_session_deleted_accepts_snake_case_agent_session_id(
        self, inbound, on_session_change
    ):
        inbound.sessions["sess-del-snake"] = {"agentSessionId": "sess-del-snake"}
        data = {
            "type": EVT_SESSION_DELETED,
            "agent_session_id": "sess-del-snake",
        }

        await inbound.handle(data)

        assert "sess-del-snake" not in inbound.sessions
        on_session_change.assert_awaited_once_with(
            "node-1", "session_deleted", data
        )

    async def test_input_request_reports_change(self, inbound, on_session_change):
        data = {
            "type": EVT_INPUT_REQUEST,
            "agentSessionId": "sess-input",
            "requestId": "input-1",
        }

        await inbound.handle(data)

        on_session_change.assert_awaited_once_with(
            "node-1", "input_request", data
        )


class TestNodeInboundEventsSubscribeFanout:
    async def test_event_with_subscribe_id_dispatches_only_selected_listener(
        self, inbound
    ):
        selected = AsyncMock()
        skipped = AsyncMock()
        inbound.register_subscribe_listener("sess-1", "sub-1", selected)
        inbound.register_subscribe_listener("sess-1", "sub-2", skipped)
        data = {
            "type": EVT_EVENT,
            "agentSessionId": "sess-1",
            "subscribeId": "sub-1",
            "payload": {"text": "targeted"},
        }

        await inbound.handle(data)

        selected.assert_awaited_once_with(data)
        skipped.assert_not_awaited()

    async def test_event_without_subscribe_id_broadcasts_to_session_listeners(
        self, inbound
    ):
        first = AsyncMock()
        second = AsyncMock()
        inbound.register_subscribe_listener("sess-1", "sub-1", first)
        inbound.register_subscribe_listener("sess-1", "sub-2", second)
        data = {
            "type": EVT_EVENT,
            "sessionId": "sess-1",
            "payload": {"text": "broadcast"},
        }

        await inbound.handle(data)

        first.assert_awaited_once_with(data)
        second.assert_awaited_once_with(data)

    async def test_unsubscribe_removes_empty_session_bucket(self, inbound):
        callback = AsyncMock()
        inbound.register_subscribe_listener("sess-1", "sub-1", callback)

        inbound.unsubscribe_events("sess-1", "sub-1")

        assert "sess-1" not in inbound.subscribe_listeners


class TestNodeInboundEventsRoutingLogs:
    async def test_health_status_logs_debug_without_callback(
        self, inbound, on_session_change, caplog
    ):
        caplog.set_level("DEBUG", logger="soulstream_server.nodes.inbound_events")

        await inbound.handle({"type": EVT_HEALTH_STATUS, "status": "ok"})

        assert "Health status from node node-1" in caplog.text
        on_session_change.assert_not_awaited()

    async def test_error_logs_warning_without_callback(
        self, inbound, on_session_change, caplog
    ):
        caplog.set_level("WARNING", logger="soulstream_server.nodes.inbound_events")

        await inbound.handle({"type": EVT_ERROR, "message": "bad node event"})

        assert "Error from node node-1: bad node event" in caplog.text
        on_session_change.assert_not_awaited()

    async def test_unknown_message_logs_debug_without_callback(
        self, inbound, on_session_change, caplog
    ):
        caplog.set_level("DEBUG", logger="soulstream_server.nodes.inbound_events")

        await inbound.handle({"type": "mystery"})

        assert "Unknown message type from node node-1: mystery" in caplog.text
        on_session_change.assert_not_awaited()
