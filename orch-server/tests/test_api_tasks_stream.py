"""Task Tree SSE stream tests."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from soulstream_server.api.task_stream import create_task_stream_response
from soulstream_server.service.task_broadcaster import TaskBroadcaster


def _make_request(headers: dict | None = None, query: dict | None = None) -> MagicMock:
    request = MagicMock()
    request.headers = headers or {}
    request.query_params = query or {}
    request.is_disconnected = AsyncMock(return_value=False)
    return request


async def _collect_n_events(
    gen,
    n: int,
    *,
    timeout_per_step: float = 1.0,
    close: bool = True,
):
    events = []
    try:
        for _ in range(n):
            try:
                events.append(await asyncio.wait_for(gen.__anext__(), timeout=timeout_per_step))
            except (asyncio.TimeoutError, StopAsyncIteration):
                break
    finally:
        if not close:
            return events
        await gen.aclose()
    return events


@pytest.mark.asyncio
async def test_task_stream_initial_snapshot_then_live_change():
    broadcaster = TaskBroadcaster()
    request = _make_request()
    snapshot = AsyncMock(return_value=[{"id": "task-1", "title": "Task"}])
    response = await create_task_stream_response(
        request,
        broadcaster=broadcaster,
        load_snapshot=snapshot,
    )
    gen = response.body_iterator

    first_two = await _collect_n_events(gen, 2)

    assert first_two[0]["event"] == "stream_meta"
    assert first_two[1]["event"] == "task_list"
    assert json.loads(first_two[1]["data"]) == {
        "type": "task_list",
        "tasks": [{"id": "task-1", "title": "Task"}],
        "total": 1,
    }

    response = await create_task_stream_response(
        request,
        broadcaster=broadcaster,
        load_snapshot=snapshot,
    )
    gen = response.body_iterator
    await _collect_n_events(gen, 2, close=False)
    await broadcaster.broadcast_task_change({"table": "task_items", "task_id": "task-1"})

    live = await _collect_n_events(gen, 1)

    assert live[0]["event"] == "task_changed"
    assert live[0]["id"] == "1"
    assert json.loads(live[0]["data"]) == {
        "type": "task_changed",
        "change": {"table": "task_items", "task_id": "task-1"},
    }


@pytest.mark.asyncio
async def test_task_stream_replays_since_last_event_id():
    broadcaster = TaskBroadcaster()
    await broadcaster.broadcast_task_change({"task_id": "task-1"})
    await broadcaster.broadcast_task_change({"task_id": "task-2"})
    request = _make_request(query={"lastEventId": "1", "instanceId": broadcaster.instance_id})

    response = await create_task_stream_response(
        request,
        broadcaster=broadcaster,
        load_snapshot=AsyncMock(return_value=[]),
    )
    events = await _collect_n_events(response.body_iterator, 2)

    assert events[0]["event"] == "stream_meta"
    assert events[1]["event"] == "task_changed"
    assert events[1]["id"] == "2"
    assert json.loads(events[1]["data"])["change"] == {"task_id": "task-2"}
