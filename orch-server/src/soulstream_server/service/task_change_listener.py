"""Postgres LISTEN bridge for Task Tree changes."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import asyncpg

from soul_common.db.session_db import PostgresSessionDB
from soulstream_server.service.task_broadcaster import TaskBroadcaster

logger = logging.getLogger(__name__)

TASK_TREE_CHANNEL = "task_tree_changed"


class TaskChangeListener:
    """Listens to DB-level task changes and emits SSE broadcaster events."""

    def __init__(
        self,
        *,
        db: PostgresSessionDB,
        broadcaster: TaskBroadcaster,
    ) -> None:
        self._db = db
        self._broadcaster = broadcaster
        self._conn: asyncpg.Connection | None = None
        self._tasks: set[asyncio.Task[None]] = set()

    async def start(self) -> None:
        if self._conn is not None:
            return
        conn = await self._db.pool.acquire()
        await conn.add_listener(TASK_TREE_CHANNEL, self._handle_notification)
        self._conn = conn
        logger.info("[task-tree] listening on Postgres channel %s", TASK_TREE_CHANNEL)

    async def stop(self) -> None:
        conn = self._conn
        self._conn = None
        if conn is not None:
            await conn.remove_listener(TASK_TREE_CHANNEL, self._handle_notification)
            await self._db.pool.release(conn)
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
            self._tasks.clear()

    def _handle_notification(
        self,
        _connection: asyncpg.Connection,
        _pid: int,
        _channel: str,
        payload: str,
    ) -> None:
        try:
            change: dict[str, Any] = json.loads(payload)
            if not isinstance(change, dict):
                change = {"raw": payload}
        except json.JSONDecodeError:
            change = {"raw": payload}

        task = asyncio.create_task(self._broadcast(change))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _broadcast(self, change: dict[str, Any]) -> None:
        try:
            await self._broadcaster.broadcast_task_change(change)
        except Exception:
            logger.exception("[task-tree] failed to broadcast task change")
