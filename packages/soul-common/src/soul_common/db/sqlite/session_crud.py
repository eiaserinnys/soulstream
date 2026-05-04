"""SqliteSessionCRUDMixin — 세션 CRUD + 읽음 상태 + 셧다운 (SQLite)"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Optional, Union

if TYPE_CHECKING:
    import aiosqlite

from soul_common.db.session_db_base import (
    SESSION_COLUMNS as _SESSION_COLUMNS,
    JSONB_COLUMNS as _JSONB_COLUMNS,
    IMMUTABLE_FIELDS,
    UPDATE_SESSION_IMMUTABLE,
    validate_immutable_fields,
)
from soul_common.db.sqlite._helpers import (
    _utc_now,
    _to_iso,
    _serialize_field,
    _deserialize_session,
)

logger = logging.getLogger(__name__)


class SqliteSessionCRUDMixin:
    """세션 CRUD + 읽음 상태 + 셧다운 관리 (SQLite 구현)

    Mixin이므로 self._conn, self._node_id는 SqliteSessionDB.__init__에서 설정된다.
    """

    _conn: aiosqlite.Connection
    _node_id: str | None

    async def upsert_session(self, session_id: str, **fields) -> None:
        invalid = set(fields) - _SESSION_COLUMNS
        if invalid:
            raise ValueError(f"Invalid session columns: {invalid}")

        # 불변 필드 보호 (IMMUTABLE_FIELDS와 SELECT 컬럼이 일치해야 가드가 동작한다)
        immutable_updates = {k: v for k, v in fields.items() if k in IMMUTABLE_FIELDS}
        if immutable_updates:
            cursor = await self._conn.execute(
                "SELECT claude_session_id, node_id, agent_id, caller_session_id "
                "FROM sessions WHERE session_id = ?",
                (session_id,),
            )
            row = await cursor.fetchone()
            if row:
                validate_immutable_fields(dict(row), immutable_updates)

        now = _utc_now()

        # created_at / updated_at 추출 (나머지 필드와 분리)
        created_at = _to_iso(fields.pop("created_at", None)) or now
        updated_at = _to_iso(fields.pop("updated_at", None)) or now

        # session_id 중복 제거
        fields.pop("session_id", None)

        # 컬럼/값 직렬화
        extra_cols = list(fields.keys())
        extra_vals = [_serialize_field(c, fields[c]) for c in extra_cols]

        all_cols = ["session_id", "created_at", "updated_at"] + extra_cols
        all_vals = [session_id, created_at, updated_at] + extra_vals

        # INSERT OR IGNORE — 이미 존재하면 UPDATE
        placeholders = ", ".join("?" * len(all_cols))
        col_str = ", ".join(all_cols)
        insert_sql = (
            f"INSERT OR IGNORE INTO sessions ({col_str}) VALUES ({placeholders})"
        )
        await self._conn.execute(insert_sql, all_vals)

        if extra_cols:
            set_clauses = ", ".join(f"{c} = ?" for c in extra_cols + ["updated_at"])
            update_vals = extra_vals + [updated_at, session_id]
            update_sql = f"UPDATE sessions SET {set_clauses} WHERE session_id = ?"
            await self._conn.execute(update_sql, update_vals)

        await self._conn.commit()

    async def register_session_initial(
        self,
        session_id: str,
        node_id: str,
        agent_id: Optional[str] = None,
        claude_session_id: Optional[str] = None,
        session_type: str = "claude",
        prompt: Optional[str] = None,
        client_id: Optional[str] = None,
        status: str = "running",
        created_at=None,
        updated_at=None,
        caller_session_id: Optional[str] = None,
    ) -> None:
        """세션 최초 등록 (순수 INSERT).

        불변 필드(session_id, node_id, agent_id, claude_session_id, caller_session_id)를
        원자적으로 기록한다 — 본 메서드가 caller_session_id의 정본 진입로다.
        중복 호출 시 UNIQUE 제약 위반 예외 발생 (INSERT OR IGNORE 없음).
        이후 update_session으로는 이 필드들을 변경할 수 없다 (UPDATE_SESSION_IMMUTABLE 가드).
        """
        now = _utc_now()
        await self._conn.execute(
            """INSERT INTO sessions
               (session_id, node_id, agent_id, claude_session_id,
                session_type, prompt, client_id, status, created_at, updated_at,
                caller_session_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                session_id,
                node_id,
                agent_id,
                claude_session_id,
                session_type,
                prompt,
                client_id,
                status,
                _to_iso(created_at) or now,
                _to_iso(updated_at) or now,
                caller_session_id,
            ),
        )
        await self._conn.commit()

    async def set_claude_session_id(
        self,
        session_id: str,
        claude_session_id: str,
    ) -> None:
        """claude_session_id 불변 설정.

        - NULL → SET (최초 설정)
        - 같은 값 → no-op (idempotent)
        - 다른 값 → ValueError (버그 탐지)
        """
        cursor = await self._conn.execute(
            "SELECT claude_session_id FROM sessions WHERE session_id = ?",
            (session_id,),
        )
        row = await cursor.fetchone()
        existing = row[0] if row else None

        if existing is None:
            await self._conn.execute(
                "UPDATE sessions SET claude_session_id = ?, updated_at = ? WHERE session_id = ?",
                (claude_session_id, _utc_now(), session_id),
            )
            await self._conn.commit()
        elif existing == claude_session_id:
            pass  # no-op
        else:
            raise ValueError(
                f"claude_session_id immutability violation: "
                f"session_id={session_id}, existing={existing!r}, new={claude_session_id!r}"
            )

    async def update_session(self, session_id: str, **fields) -> None:
        """세션 속성 갱신 (순수 UPDATE).

        불변 필드(node_id, agent_id, claude_session_id, session_type, created_at,
        caller_session_id)는 허용하지 않는다 — ValueError를 발생시킨다.
        """
        invalid = set(fields) & UPDATE_SESSION_IMMUTABLE
        if invalid:
            raise ValueError(f"Immutable fields cannot be updated via update_session: {invalid}")

        now = _utc_now()
        updated_at = _to_iso(fields.pop("updated_at", None)) or now
        fields.pop("session_id", None)

        if not fields:
            await self._conn.execute(
                "UPDATE sessions SET updated_at = ? WHERE session_id = ?",
                (updated_at, session_id),
            )
        else:
            extra_cols = list(fields.keys())
            extra_vals = [_serialize_field(c, fields[c]) for c in extra_cols]
            set_clauses = ", ".join(f"{c} = ?" for c in extra_cols + ["updated_at"])
            await self._conn.execute(
                f"UPDATE sessions SET {set_clauses} WHERE session_id = ?",
                extra_vals + [updated_at, session_id],
            )

        await self._conn.commit()

    async def get_session(self, session_id: str) -> Optional[dict]:
        cursor = await self._conn.execute(
            "SELECT * FROM sessions WHERE session_id = ?", (session_id,)
        )
        row = await cursor.fetchone()
        return _deserialize_session(row) if row else None

    async def get_all_sessions(
        self,
        offset: int = 0,
        limit: int = 0,
        session_type: Optional[str] = None,
        folder_id: Optional[str] = None,
        node_id: Optional[str] = None,
        status: Optional[Union[str, list[str]]] = None,
    ) -> tuple[list[dict], int]:
        where, params = self._build_session_filters(
            session_type=session_type,
            folder_id=folder_id,
            node_id=node_id,
            status=status,
        )

        count_sql = f"SELECT COUNT(*) FROM sessions{where}"
        cursor = await self._conn.execute(count_sql, params)
        total = (await cursor.fetchone())[0]

        data_sql = f"SELECT * FROM sessions{where} ORDER BY updated_at DESC"
        if limit > 0:
            data_sql += f" LIMIT {int(limit)}"
        if offset > 0:
            data_sql += f" OFFSET {int(offset)}"

        cursor = await self._conn.execute(data_sql, params)
        rows = await cursor.fetchall()
        return [_deserialize_session(r) for r in rows], total

    @staticmethod
    def _build_session_filters(
        session_type: Optional[str] = None,
        folder_id: Optional[str] = None,
        node_id: Optional[str] = None,
        status: Optional[Union[str, list[str]]] = None,
    ) -> tuple[str, list]:
        clauses = []
        params: list = []
        if session_type:
            clauses.append("session_type = ?")
            params.append(session_type)
        if folder_id:
            clauses.append("folder_id = ?")
            params.append(folder_id)
        if node_id:
            clauses.append("node_id = ?")
            params.append(node_id)
        if status is not None:
            if isinstance(status, list):
                placeholders = ", ".join("?" * len(status))
                clauses.append(f"status IN ({placeholders})")
                params.extend(status)
            else:
                clauses.append("status = ?")
                params.append(status)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        return where, params

    async def delete_session(self, session_id: str) -> None:
        await self._conn.execute(
            "DELETE FROM sessions WHERE session_id = ?", (session_id,)
        )
        await self._conn.commit()

    async def update_session_status(self, session_id: str, status: str) -> None:
        await self._conn.execute(
            "UPDATE sessions SET status = ?, updated_at = ? WHERE session_id = ?",
            (status, _utc_now(), session_id),
        )
        await self._conn.commit()

    async def append_metadata(self, session_id: str, entry: dict) -> None:
        """세션 metadata JSONB에 엔트리를 원자적으로 추가한다."""
        now = _utc_now()
        cursor = await self._conn.execute(
            "SELECT metadata FROM sessions WHERE session_id = ?", (session_id,)
        )
        row = await cursor.fetchone()
        if row is None:
            return

        existing = row["metadata"]
        if isinstance(existing, str):
            try:
                existing = json.loads(existing)
            except (json.JSONDecodeError, TypeError):
                existing = []
        if not isinstance(existing, list):
            existing = []

        existing.append(entry)
        new_metadata = json.dumps(existing, ensure_ascii=False)

        searchable = f"{entry.get('type', '')}: {entry.get('value', '')} {entry.get('label', '')}"
        event_payload = json.dumps({
            "type": "metadata",
            "metadata_type": entry.get("type"),
            "value": entry.get("value"),
            "label": entry.get("label"),
        }, ensure_ascii=False)

        await self._conn.execute(
            "UPDATE sessions SET metadata = ?, updated_at = ? WHERE session_id = ?",
            (new_metadata, now, session_id),
        )
        await self._conn.commit()

        await self.append_event(
            session_id, "metadata", event_payload, searchable, now
        )

    async def update_last_message(self, session_id: str, last_message: dict) -> None:
        now = _utc_now()
        msg_json = json.dumps(last_message, ensure_ascii=False)
        await self._conn.execute(
            "UPDATE sessions SET last_message = ?, updated_at = ? WHERE session_id = ?",
            (msg_json, now, session_id),
        )
        await self._conn.commit()

    async def update_away_summary(self, session_id: str, summary: str) -> None:
        now = _utc_now()
        await self._conn.execute(
            "UPDATE sessions SET away_summary = ?, updated_at = ? WHERE session_id = ?",
            (summary, now, session_id),
        )
        await self._conn.commit()

    # --- 읽음 상태 관리 ---

    async def update_last_read_event_id(self, session_id: str, event_id: int) -> bool:
        cursor = await self._conn.execute(
            "UPDATE sessions SET last_read_event_id = ? WHERE session_id = ?",
            (event_id, session_id),
        )
        await self._conn.commit()
        return cursor.rowcount > 0

    async def get_read_position(self, session_id: str) -> tuple[int, int]:
        cursor = await self._conn.execute(
            "SELECT last_event_id, last_read_event_id FROM sessions WHERE session_id = ?",
            (session_id,),
        )
        row = await cursor.fetchone()
        if row is None:
            raise ValueError(f"Session not found: {session_id}")
        return (row["last_event_id"] or 0, row["last_read_event_id"] or 0)

    async def mark_running_at_shutdown(self, session_ids: list[str] | None = None) -> None:
        if session_ids is not None:
            if not session_ids:
                return
            placeholders = ", ".join("?" * len(session_ids))
            await self._conn.execute(
                f"UPDATE sessions SET was_running_at_shutdown = 1"
                f" WHERE session_id IN ({placeholders})",
                session_ids,
            )
        else:
            await self._conn.execute(
                "UPDATE sessions SET was_running_at_shutdown = 1"
                " WHERE status IN ('running', 'starting')"
            )
        await self._conn.commit()

    async def get_shutdown_sessions(self) -> list[dict]:
        where = " WHERE was_running_at_shutdown = 1"
        params: list = []
        if self._node_id is not None:
            where += " AND node_id = ?"
            params.append(self._node_id)
        cursor = await self._conn.execute(
            f"SELECT * FROM sessions{where}", params
        )
        rows = await cursor.fetchall()
        return [_deserialize_session(r) for r in rows]

    async def repair_broken_read_positions(self) -> int:
        """last_read_event_id > last_event_id 인 세션을 복구한다."""
        cursor = await self._conn.execute(
            """
            UPDATE sessions
            SET last_read_event_id = last_event_id
            WHERE last_read_event_id IS NOT NULL
              AND last_event_id IS NOT NULL
              AND last_read_event_id > last_event_id
            """
        )
        await self._conn.commit()
        count = cursor.rowcount
        if count:
            logger.info("Repaired %d sessions with broken read positions", count)
        return count

    async def clear_shutdown_flags(self) -> None:
        where = ""
        params: list = []
        if self._node_id is not None:
            where = " WHERE node_id = ?"
            params.append(self._node_id)
        await self._conn.execute(
            f"UPDATE sessions SET was_running_at_shutdown = 0{where}", params
        )
        await self._conn.commit()
