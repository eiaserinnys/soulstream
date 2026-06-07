"""Supervisor ingest service tests."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from soulstream_server.service.supervisor_ingest import SupervisorIngestService


class FakeSupervisorDB:
    def __init__(self):
        self.append_supervisor_event = AsyncMock(side_effect=self._append)
        self.get_supervisor_source_cursor = AsyncMock()
        self.read_events = AsyncMock()
        self.appended: list[dict] = []

    async def _append(self, **kwargs):
        key = (
            kwargs["source_node"],
            kwargs["source_session_id"],
            kwargs["source_event_id"],
        )
        inserted = key not in {
            (row["source_node"], row["source_session_id"], row["source_event_id"])
            for row in self.appended
        }
        self.appended.append(kwargs)
        return {
            "offset": len(self.appended),
            "inserted": inserted,
            "contiguous_upto": kwargs["source_event_id"],
            "highest_seen_event_id": kwargs["source_event_id"],
        }


@pytest.mark.asyncio
async def test_append_event_envelope_uses_raw_event_key_and_payload():
    db = FakeSupervisorDB()
    service = SupervisorIngestService(db)

    result = await service.append_event_envelope(
        "node-1",
        {
            "type": "event",
            "agentSessionId": "sess-1",
            "event": {
                "_event_id": 7,
                "type": "complete",
                "usage": {"input_tokens": 11, "output_tokens": 13},
                "timestamp": 1,
            },
        },
    )

    assert result is not None
    db.append_supervisor_event.assert_awaited_once()
    call = db.append_supervisor_event.await_args.kwargs
    assert call["source_node"] == "node-1"
    assert call["source_session_id"] == "sess-1"
    assert call["source_event_id"] == 7
    assert call["event_type"] == "complete"
    assert call["payload"]["usage"] == {"input_tokens": 11, "output_tokens": 13}


@pytest.mark.asyncio
async def test_append_event_envelope_adds_lazy_summary_lookup_for_session_ended():
    db = FakeSupervisorDB()
    service = SupervisorIngestService(db)

    await service.append_event_envelope(
        "node-1",
        {
            "agentSessionId": "sess-end",
            "event": {"_event_id": 8, "type": "session_ended"},
        },
    )

    call = db.append_supervisor_event.await_args.kwargs
    assert call["payload"]["summary_lookup"] == {
        "tool": "get_session_summary",
        "session_id": "sess-end",
    }


@pytest.mark.asyncio
async def test_append_node_change_uses_last_event_id_as_idempotent_source_key():
    db = FakeSupervisorDB()
    service = SupervisorIngestService(db)

    await service.append_node_change(
        "node_session_session_updated",
        "node-1",
        {"agentSessionId": "sess-1", "last_event_id": 12, "status": "running"},
    )

    call = db.append_supervisor_event.await_args.kwargs
    assert call["source_event_id"] == 12
    assert call["event_type"] == "session_updated"
    assert call["payload"]["status"] == "running"


@pytest.mark.asyncio
async def test_sync_sessions_replays_from_contiguous_cursor_not_highest_seen():
    db = FakeSupervisorDB()
    db.get_supervisor_source_cursor.return_value = {
        "contiguous_upto": 1,
        "highest_seen_event_id": 4,
        "gap_start": 2,
        "gap_end": 3,
    }
    db.read_events.side_effect = [
        [
            {
                "id": 2,
                "event_type": "assistant_message",
                "payload": '{"type":"assistant_message","content":"a"}',
                "created_at": "2026-06-07T00:00:00+00:00",
            },
            {
                "id": 3,
                "event_type": "complete",
                "payload": {"type": "complete"},
                "created_at": "2026-06-07T00:00:01+00:00",
            },
        ],
        [],
    ]
    service = SupervisorIngestService(db, replay_batch_size=2)

    await service.sync_sessions_from_dump(
        "node-1",
        [{"agentSessionId": "sess-1", "last_event_id": 4}],
    )

    db.read_events.assert_awaited_with("sess-1", after_id=3, limit=2)
    assert [row["source_event_id"] for row in db.appended] == [2, 3]


@pytest.mark.asyncio
async def test_sync_sessions_skips_when_contiguous_cursor_covers_node_last_event():
    db = FakeSupervisorDB()
    db.get_supervisor_source_cursor.return_value = {
        "contiguous_upto": 5,
        "highest_seen_event_id": 5,
    }
    service = SupervisorIngestService(db)

    await service.sync_sessions_from_dump(
        "node-1",
        [{"agentSessionId": "sess-1", "last_event_id": 5}],
    )

    db.read_events.assert_not_awaited()
    db.append_supervisor_event.assert_not_awaited()
