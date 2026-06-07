"""PostgresSupervisorMixin — Supervisor durable queue DB API."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    import asyncpg


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _json_dumps(value: object) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def _json_loads(value: object) -> object:
    if isinstance(value, str):
        return json.loads(value)
    return value


def _row_to_dict(row: asyncpg.Record | None) -> Optional[dict]:
    if row is None:
        return None
    data = dict(row)
    for key in ("payload",):
        if key in data and data[key] is not None:
            data[key] = _json_loads(data[key])
    return data


class PostgresSupervisorMixin:
    """Supervisor durable queue, cursor, and registry API."""

    _pool: asyncpg.Pool

    async def append_supervisor_event(
        self,
        *,
        source_node: str,
        source_session_id: str,
        source_event_id: int,
        event_type: str,
        payload: object,
        created_at: datetime | str | None = None,
    ) -> dict:
        if isinstance(created_at, str):
            try:
                created_at = datetime.fromisoformat(created_at)
            except ValueError:
                created_at = _utc_now()
        if created_at is None:
            created_at = _utc_now()

        row = await self._pool.fetchrow(
            "SELECT * FROM supervisor_event_append($1, $2, $3, $4, $5, $6)",
            source_node,
            source_session_id,
            source_event_id,
            event_type,
            _json_dumps(payload),
            created_at,
        )
        result = _row_to_dict(row)
        if result is None:
            raise RuntimeError("supervisor_event_append returned no row")
        return result

    async def read_supervisor_events_after(
        self,
        after_offset: int = 0,
        limit: int = 100,
    ) -> list[dict]:
        rows = await self._pool.fetch(
            "SELECT * FROM supervisor_event_read_after($1, $2)",
            after_offset,
            limit,
        )
        return [_row_to_dict(row) for row in rows]

    async def get_supervisor_source_cursor(
        self,
        source_node: str,
        source_session_id: str,
    ) -> Optional[dict]:
        row = await self._pool.fetchrow(
            "SELECT * FROM supervisor_source_cursor_get($1, $2)",
            source_node,
            source_session_id,
        )
        return _row_to_dict(row)

    async def set_supervisor_source_cursor(
        self,
        *,
        source_node: str,
        source_session_id: str,
        contiguous_upto: int,
        highest_seen_event_id: int,
        gap_start: int | None = None,
        gap_end: int | None = None,
    ) -> dict:
        row = await self._pool.fetchrow(
            "SELECT * FROM supervisor_source_cursor_set($1, $2, $3, $4, $5, $6)",
            source_node,
            source_session_id,
            contiguous_upto,
            highest_seen_event_id,
            gap_start,
            gap_end,
        )
        result = _row_to_dict(row)
        if result is None:
            raise RuntimeError("supervisor_source_cursor_set returned no row")
        return result

    async def get_supervisor_consumer_cursor(self, supervisor_id: str) -> int:
        value = await self._pool.fetchval(
            "SELECT supervisor_consumer_cursor_get($1)",
            supervisor_id,
        )
        return int(value or 0)

    async def set_supervisor_consumer_cursor(
        self,
        supervisor_id: str,
        cursor_offset: int,
    ) -> int:
        value = await self._pool.fetchval(
            "SELECT supervisor_consumer_cursor_set($1, $2)",
            supervisor_id,
            cursor_offset,
        )
        return int(value or 0)

    async def upsert_supervisor_registry(
        self,
        *,
        role: str,
        active_session_id: str | None,
        epoch: int,
        cursor_offset: int,
        handover_state: str,
        cumulative_tokens: int,
        compaction_count: int,
        last_seen_at: datetime | None,
    ) -> dict:
        row = await self._pool.fetchrow(
            "SELECT * FROM supervisor_registry_upsert($1, $2, $3, $4, $5, $6, $7, $8)",
            role,
            active_session_id,
            epoch,
            cursor_offset,
            handover_state,
            cumulative_tokens,
            compaction_count,
            last_seen_at,
        )
        result = _row_to_dict(row)
        if result is None:
            raise RuntimeError("supervisor_registry_upsert returned no row")
        return result

    async def record_supervisor_usage_delta(
        self,
        *,
        role: str,
        token_delta: int,
        compaction_delta: int = 0,
        last_seen_at: datetime | None = None,
    ) -> dict:
        row = await self._pool.fetchrow(
            "SELECT * FROM supervisor_registry_record_usage_delta($1, $2, $3, $4)",
            role,
            token_delta,
            compaction_delta,
            last_seen_at,
        )
        result = _row_to_dict(row)
        if result is None:
            raise RuntimeError("supervisor_registry_record_usage_delta returned no row")
        return result

    async def get_supervisor_registry(self, role: str) -> Optional[dict]:
        row = await self._pool.fetchrow(
            "SELECT * FROM supervisor_registry_get($1)",
            role,
        )
        return _row_to_dict(row)

    async def list_supervisor_registries(self) -> list[dict]:
        rows = await self._pool.fetch("SELECT * FROM supervisor_registry_list()")
        return [_row_to_dict(row) for row in rows]

    async def touch_supervisor_registry(
        self,
        role: str,
        last_seen_at: datetime,
    ) -> Optional[dict]:
        row = await self._pool.fetchrow(
            "SELECT * FROM supervisor_registry_touch($1, $2)",
            role,
            last_seen_at,
        )
        return _row_to_dict(row)

    async def delete_supervisor_registry(self, role: str) -> bool:
        value = await self._pool.fetchval(
            "SELECT supervisor_registry_delete($1)",
            role,
        )
        return bool(value)
