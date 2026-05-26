"""Task Tree SSE stream."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import Request
from sse_starlette.sse import EventSourceResponse

from soulstream_server.service.task_broadcaster import TaskBroadcaster

TaskSnapshotLoader = Callable[[], Awaitable[list[dict[str, Any]]]]


async def create_task_stream_response(
    request: Request,
    *,
    broadcaster: TaskBroadcaster | None,
    load_snapshot: TaskSnapshotLoader,
) -> EventSourceResponse:
    """Create `/api/tasks/stream` response with Last-Event-ID resume support."""

    last_event_id_str = (
        request.headers.get("last-event-id")
        or request.query_params.get("lastEventId")
    )
    client_instance_id = request.query_params.get("instanceId")
    last_event_id: int | None = None
    if last_event_id_str:
        try:
            last_event_id = int(last_event_id_str)
        except ValueError:
            last_event_id = None

    async def event_generator():
        if broadcaster is None:
            while True:
                if await request.is_disconnected():
                    return
                yield {"comment": "keepalive"}
                await asyncio.sleep(30)
            return

        queue: asyncio.Queue[tuple[int, dict] | None] | None = None
        replay_seen_ids: set[int] = set()
        try:
            queue = broadcaster.add_client()
            yield {
                "event": "stream_meta",
                "data": json.dumps({
                    "type": "stream_meta",
                    "instance_id": broadcaster.instance_id,
                    "latest_id": broadcaster.latest_event_id,
                }),
            }

            if last_event_id is None:
                tasks = await load_snapshot()
                yield {
                    "event": "task_list",
                    "data": json.dumps({
                        "type": "task_list",
                        "tasks": tasks,
                        "total": len(tasks),
                    }),
                }
            else:
                replay = broadcaster.replay_since(last_event_id, client_instance_id)
                if replay.gap:
                    yield {
                        "event": "replay_gap",
                        "data": json.dumps({
                            "type": "replay_gap",
                            "latest_id": replay.latest_id,
                            "instance_id": replay.instance_id,
                        }),
                    }
                else:
                    for eid, ev in replay.events:
                        yield {
                            "event": ev.get("type", "message"),
                            "id": str(eid),
                            "data": json.dumps(ev),
                        }
                    replay_seen_ids = {eid for eid, _ in replay.events}

            while True:
                if await request.is_disconnected():
                    break
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=30)
                except asyncio.TimeoutError:
                    yield {"comment": "keepalive"}
                    continue
                if item is None:
                    break
                eid, event = item
                if eid in replay_seen_ids:
                    continue
                yield {
                    "event": event.get("type", "message"),
                    "id": str(eid),
                    "data": json.dumps(event),
                }
        finally:
            if queue is not None:
                broadcaster.remove_client(queue)

    return EventSourceResponse(event_generator())
