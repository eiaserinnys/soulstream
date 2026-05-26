"""Task Tree SSE broadcaster."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from soul_common.broadcaster import BaseSessionBroadcaster


class TaskBroadcaster(BaseSessionBroadcaster):
    """Broadcasts Task Tree change notifications to dashboard clients."""

    def __init__(self) -> None:
        super().__init__(use_lock=False, recent_events_ttl_sec=1800.0)

    async def broadcast_task_change(self, change: dict[str, Any] | None = None) -> int:
        return await self.broadcast({
            "type": "task_changed",
            "change": change or {},
        })

    async def subscribe(self) -> AsyncIterator[tuple[int, dict[str, Any]]]:
        queue = self.add_client()
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                yield item
        finally:
            self.remove_client(queue)
