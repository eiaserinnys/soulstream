"""Supervisor event ingestion boundary."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Protocol


logger = logging.getLogger(__name__)


class SupervisorIngestDB(Protocol):
    async def append_supervisor_event(
        self,
        *,
        source_node: str,
        source_session_id: str,
        source_event_id: int,
        event_type: str,
        payload: object,
        created_at: datetime | str | None = None,
    ) -> dict: ...

    async def get_supervisor_source_cursor(
        self,
        source_node: str,
        source_session_id: str,
    ) -> dict | None: ...

    async def read_events(
        self,
        session_id: str,
        after_id: int = 0,
        limit: int | None = None,
        event_types: list[str] | None = None,
    ) -> list[dict]: ...


def _nested_session(data: dict) -> dict:
    session = data.get("session")
    return session if isinstance(session, dict) else {}


def _session_id_from_payload(data: dict) -> str | None:
    session = _nested_session(data)
    session_id = (
        data.get("agentSessionId")
        or data.get("agent_session_id")
        or data.get("sessionId")
        or data.get("session_id")
        or session.get("agentSessionId")
        or session.get("agent_session_id")
        or session.get("sessionId")
        or session.get("session_id")
    )
    return session_id if isinstance(session_id, str) and session_id else None


def _event_payload(data: dict) -> dict:
    event = data.get("event")
    if isinstance(event, dict):
        return event
    payload = data.get("payload")
    return payload if isinstance(payload, dict) else {}


def _int_value(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, float) and value.is_integer():
        parsed = int(value)
        return parsed if parsed > 0 else None
    if isinstance(value, str):
        try:
            parsed = int(value)
        except ValueError:
            return None
        return parsed if parsed > 0 else None
    return None


def _event_id_from_session_like(data: dict) -> int | None:
    session = _nested_session(data)
    for candidate in (
        data.get("last_event_id"),
        data.get("lastEventId"),
        data.get("_event_id"),
        data.get("event_id"),
        session.get("last_event_id"),
        session.get("lastEventId"),
    ):
        parsed = _int_value(candidate)
        if parsed is not None:
            return parsed
    return None


def _event_id_from_event(event: dict, envelope: dict | None = None) -> int | None:
    for candidate in (
        event.get("_event_id"),
        event.get("event_id"),
        event.get("eventId"),
        event.get("id"),
    ):
        parsed = _int_value(candidate)
        if parsed is not None:
            return parsed
    return _event_id_from_session_like(envelope) if envelope is not None else None


def _event_type_from_event(event: dict) -> str:
    event_type = event.get("type") or event.get("event_type") or event.get("eventType")
    return event_type if isinstance(event_type, str) and event_type else "event"


def _created_at_from_event(event: dict) -> datetime | str | None:
    created_at = event.get("created_at") or event.get("createdAt")
    if isinstance(created_at, str) and created_at:
        return created_at
    timestamp = event.get("timestamp")
    if isinstance(timestamp, bool):
        return None
    if isinstance(timestamp, (int, float)):
        return datetime.fromtimestamp(timestamp, tz=timezone.utc)
    return None


def _payload_from_db_event(event: dict) -> dict:
    payload = event.get("payload")
    if isinstance(payload, dict):
        result = {**payload}
    elif isinstance(payload, str):
        try:
            decoded = json.loads(payload)
            result = decoded if isinstance(decoded, dict) else {"payload": decoded}
        except json.JSONDecodeError:
            result = {"payload": payload}
    else:
        result = {}
    result.setdefault("type", event.get("event_type") or event.get("eventType") or "event")
    event_id = _int_value(event.get("id"))
    if event_id is not None:
        result.setdefault("_event_id", event_id)
    return result


def _node_change_payload(event_type: str, data: dict) -> dict:
    payload = {**data}
    payload.setdefault("type", event_type.removeprefix("node_session_"))
    return payload


class SupervisorIngestService:
    def __init__(self, db: SupervisorIngestDB, *, replay_batch_size: int = 500) -> None:
        self._db = db
        self._replay_batch_size = replay_batch_size

    async def append_event_envelope(self, source_node: str, envelope: dict) -> dict | None:
        session_id = _session_id_from_payload(envelope)
        if not session_id:
            logger.debug("supervisor ingest skipped EVT_EVENT without session id")
            return None
        event = _event_payload(envelope)
        source_event_id = _event_id_from_event(event, envelope)
        if source_event_id is None:
            logger.debug(
                "supervisor ingest skipped EVT_EVENT without positive event id: session=%s",
                session_id,
            )
            return None

        payload = {**event}
        payload.setdefault("_event_id", source_event_id)
        event_type = _event_type_from_event(payload)
        if event_type == "session_ended":
            payload.setdefault(
                "summary_lookup",
                {"tool": "get_session_summary", "session_id": session_id},
            )
        return await self._append(
            source_node=source_node,
            source_session_id=session_id,
            source_event_id=source_event_id,
            event_type=event_type,
            payload=payload,
            created_at=_created_at_from_event(payload),
        )

    async def append_node_change(
        self,
        event_type: str,
        source_node: str,
        data: dict | None,
    ) -> dict | None:
        if not event_type.startswith("node_session_"):
            return None
        if not data:
            return None
        session_id = _session_id_from_payload(data)
        source_event_id = _event_id_from_session_like(data)
        if not session_id or source_event_id is None:
            return None
        return await self._append(
            source_node=source_node,
            source_session_id=session_id,
            source_event_id=source_event_id,
            event_type=event_type.removeprefix("node_session_"),
            payload=_node_change_payload(event_type, data),
            created_at=None,
        )

    async def sync_sessions_from_dump(self, source_node: str, sessions: list[dict]) -> None:
        for session in sessions:
            if not isinstance(session, dict):
                continue
            session_id = _session_id_from_payload(session)
            last_event_id = _event_id_from_session_like(session)
            if not session_id or last_event_id is None:
                continue
            try:
                cursor = await self._db.get_supervisor_source_cursor(
                    source_node,
                    session_id,
                )
                after_id = int((cursor or {}).get("contiguous_upto") or 0)
                if last_event_id <= after_id:
                    continue
                await self.replay_session_events(
                    source_node=source_node,
                    source_session_id=session_id,
                    after_id=after_id,
                )
            except Exception:
                logger.exception(
                    "supervisor session replay failed: node=%s session=%s last_event_id=%s",
                    source_node,
                    session_id,
                    last_event_id,
                )

    async def replay_session_events(
        self,
        *,
        source_node: str,
        source_session_id: str,
        after_id: int,
    ) -> None:
        cursor = after_id
        while True:
            events = await self._db.read_events(
                source_session_id,
                after_id=cursor,
                limit=self._replay_batch_size,
            )
            if not events:
                return
            for event in events:
                source_event_id = _int_value(event.get("id"))
                if source_event_id is None:
                    continue
                payload = _payload_from_db_event(event)
                if payload.get("type") == "session_ended":
                    payload.setdefault(
                        "summary_lookup",
                        {
                            "tool": "get_session_summary",
                            "session_id": source_session_id,
                        },
                    )
                await self._append(
                    source_node=source_node,
                    source_session_id=source_session_id,
                    source_event_id=source_event_id,
                    event_type=str(payload.get("type") or "event"),
                    payload=payload,
                    created_at=event.get("created_at"),
                )
                cursor = source_event_id
            if len(events) < self._replay_batch_size:
                return

    async def _append(
        self,
        *,
        source_node: str,
        source_session_id: str,
        source_event_id: int,
        event_type: str,
        payload: dict,
        created_at: datetime | str | None,
    ) -> dict | None:
        try:
            return await self._db.append_supervisor_event(
                source_node=source_node,
                source_session_id=source_session_id,
                source_event_id=source_event_id,
                event_type=event_type,
                payload=payload,
                created_at=created_at,
            )
        except Exception:
            logger.exception(
                "supervisor event append failed: node=%s session=%s event_id=%s type=%s",
                source_node,
                source_session_id,
                source_event_id,
                event_type,
            )
            return None
