"""PostgresSessionCRUDMixin — 세션 CRUD + 읽음 상태 + 셧다운 (PostgreSQL)"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Optional, Union

if TYPE_CHECKING:
    import asyncpg

from soul_common.db.session_db_base import (
    SESSION_COLUMNS as _SESSION_COLUMNS,
    JSONB_COLUMNS as _JSONB_COLUMNS,
    TIMESTAMP_COLUMNS as _TIMESTAMP_COLUMNS,
    IMMUTABLE_FIELDS,
    UPDATE_SESSION_IMMUTABLE,
    validate_immutable_fields,
)

logger = logging.getLogger(__name__)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _deserialize_session(row: asyncpg.Record) -> dict:
    """asyncpg Record를 Python dict으로 역직렬화한다."""
    d = dict(row)
    # asyncpg가 JSONB를 자동으로 Python 객체로 변환하므로
    # 추가 역직렬화 불필요. 단, 문자열로 저장된 경우 처리
    for field in ("last_message", "metadata"):
        if isinstance(d.get(field), str):
            try:
                d[field] = json.loads(d[field])
            except (json.JSONDecodeError, TypeError):
                pass
    # boolean 변환 (PostgreSQL BOOLEAN → Python bool)
    if "was_running_at_shutdown" in d:
        d["was_running_at_shutdown"] = bool(d["was_running_at_shutdown"])
    return d


class PostgresSessionCRUDMixin:
    """세션 CRUD + 읽음 상태 + 셧다운 관리 (PostgreSQL 구현)

    Mixin이므로 self._pool, self._node_id는 PostgresSessionDB.__init__에서 설정된다.
    """

    _pool: asyncpg.Pool
    _node_id: str | None

    async def upsert_session(self, session_id: str, **fields) -> None:
        invalid = set(fields) - _SESSION_COLUMNS
        if invalid:
            raise ValueError(f"Invalid session columns: {invalid}")

        # 불변 필드 보호 (IMMUTABLE_FIELDS와 SELECT 컬럼이 일치해야 가드가 동작한다)
        immutable_updates = {k: v for k, v in fields.items() if k in IMMUTABLE_FIELDS}
        if immutable_updates:
            row = await self._pool.fetchrow(
                "SELECT claude_session_id, node_id, agent_id, caller_session_id "
                "FROM sessions WHERE session_id = $1",
                session_id,
            )
            if row:
                validate_immutable_fields(dict(row), immutable_updates)

        # JSONB 컬럼은 JSON 문자열로 직렬화
        for col in _JSONB_COLUMNS:
            if col in fields and isinstance(fields[col], (dict, list)):
                fields[col] = json.dumps(fields[col], ensure_ascii=False)

        # timestamptz 컬럼: 문자열이면 그대로 유지 (프로시저가 ::timestamptz로 캐스트)
        # datetime이면 isoformat 문자열로 변환
        for col in _TIMESTAMP_COLUMNS:
            if col in fields and isinstance(fields[col], datetime):
                fields[col] = fields[col].isoformat()

        now = _utc_now()
        created_at = now
        updated_at = now

        # fields에서 created_at, updated_at을 별도로 추출
        if "created_at" in fields:
            v = fields.pop("created_at")
            created_at = v if isinstance(v, datetime) else datetime.fromisoformat(v) if isinstance(v, str) else v
        if "updated_at" in fields:
            v = fields.pop("updated_at")
            updated_at = v if isinstance(v, datetime) else datetime.fromisoformat(v) if isinstance(v, str) else v

        # session_id는 fields에서 제외
        fields.pop("session_id", None)

        # 동적 컬럼/값 배열 구성
        columns = list(fields.keys())
        values = []
        for c in columns:
            v = fields[c]
            if v is None:
                values.append(None)
            elif isinstance(v, bool):
                values.append(str(v).lower())
            elif isinstance(v, (int, float)):
                values.append(str(v))
            else:
                values.append(str(v))

        await self._pool.execute(
            "SELECT session_upsert($1, $2, $3, $4, $5)",
            session_id, columns, values, created_at, updated_at,
        )

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
        created_at: Optional[datetime] = None,
        updated_at: Optional[datetime] = None,
        caller_session_id: Optional[str] = None,
    ) -> None:
        """세션 최초 등록 (순수 INSERT).

        불변 필드(session_id, node_id, agent_id, claude_session_id, caller_session_id)를
        원자적으로 기록한다 — 본 메서드가 caller_session_id의 정본 진입로다.
        중복 호출 시 DB 고유 제약 위반 예외 발생 (ON CONFLICT 없음).
        이후 update_session으로는 이 필드들을 변경할 수 없다 (UPDATE_SESSION_IMMUTABLE 가드).
        """
        now = _utc_now()
        await self._pool.execute(
            "SELECT session_register($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
            session_id,
            node_id,
            agent_id,
            claude_session_id,
            session_type,
            prompt,
            client_id,
            status,
            created_at or now,
            updated_at or now,
            caller_session_id,
        )

    async def set_claude_session_id(
        self,
        session_id: str,
        claude_session_id: str,
    ) -> None:
        """claude_session_id 불변 설정.

        - NULL → SET (최초 설정)
        - 같은 값 → no-op (idempotent)
        - 다른 값 → RAISE EXCEPTION (버그 탐지) → asyncpg.PostgresError로 전파
        """
        await self._pool.execute(
            "SELECT session_set_claude_id($1, $2)",
            session_id,
            claude_session_id,
        )

    async def update_session(self, session_id: str, **fields) -> None:
        """세션 속성 갱신 (순수 UPDATE).

        불변 필드(node_id, agent_id, claude_session_id, session_type, created_at,
        caller_session_id)는 허용하지 않는다 — ValueError를 발생시킨다.
        DB 프로시저(session_update)도 화이트리스트(schema.sql L257-262) 밖이라
        동일하게 RAISE EXCEPTION 'Invalid or immutable session column'을 던진다.
        Python 레벨 + DB SP의 이중 가드로 보호된다.
        caller_session_id의 정본 진입로는 register_session_initial이다.
        """
        invalid = set(fields) & UPDATE_SESSION_IMMUTABLE
        if invalid:
            raise ValueError(f"Immutable fields cannot be updated via update_session: {invalid}")

        now = _utc_now()
        if "updated_at" in fields:
            v = fields.pop("updated_at")
            updated_at = v if isinstance(v, datetime) else datetime.fromisoformat(v) if isinstance(v, str) else now
        else:
            updated_at = now

        fields.pop("session_id", None)

        # JSONB 직렬화
        for col in _JSONB_COLUMNS:
            if col in fields and isinstance(fields[col], (dict, list)):
                fields[col] = json.dumps(fields[col], ensure_ascii=False)

        columns = list(fields.keys())
        values = []
        for c in columns:
            v = fields[c]
            if v is None:
                values.append(None)
            elif isinstance(v, bool):
                values.append(str(v).lower())
            elif isinstance(v, (int, float)):
                values.append(str(v))
            else:
                values.append(str(v))

        await self._pool.execute(
            "SELECT session_update($1, $2, $3, $4)",
            session_id, columns, values, updated_at,
        )

    async def get_session(self, session_id: str) -> Optional[dict]:
        row = await self._pool.fetchrow(
            "SELECT * FROM session_get($1)", session_id
        )
        if row is None:
            return None
        return _deserialize_session(row)

    async def get_all_sessions(
        self,
        offset: int = 0,
        limit: int = 0,
        session_type: Optional[str] = None,
        folder_id: Optional[str] = None,
        node_id: Optional[str] = None,
        status: Optional[Union[str, list[str]]] = None,
        feed_only: bool = False,
    ) -> tuple[list[dict], int]:
        """세션 목록 조회.

        feed_only는 PostgresSessionCRUDMixin 전용 파라미터이다.
        SessionDBBase ABC에는 이 파라미터가 없으며, 이는 기존 정책
        ("구현 전용 확장은 ABC에 포함하지 않는다")을 따른 것이다.
        """
        # 필터를 JSONB dict으로 직렬화
        filters = {}
        if session_type:
            filters["session_type"] = session_type
        if folder_id:
            filters["folder_id"] = folder_id
        if node_id:
            filters["node_id"] = node_id
        if status is not None:
            filters["status"] = status
        if feed_only:
            filters["feed_only"] = True
        filters_json = json.dumps(filters) if filters else None

        total = await self._pool.fetchval(
            "SELECT session_count($1::jsonb)", filters_json
        )

        p_limit = limit if limit > 0 else None
        p_offset = offset if offset > 0 else None

        rows = await self._pool.fetch(
            "SELECT * FROM session_get_all($1::jsonb, $2, $3)",
            filters_json, p_limit, p_offset,
        )
        return [_deserialize_session(r) for r in rows], total

    async def get_folder_counts(
        self,
        node_id: Optional[str] = None,
    ) -> dict:
        """folder_id별 세션 수를 반환한다.

        PostgreSQL 구현 전용 메서드 — SessionDBBase ABC에 없다.

        Args:
            node_id: 특정 노드로 필터링. None이면 전체.

        Returns:
            {folder_id: count} — folder_id가 None인 경우(폴더 미지정 세션)도 포함
        """
        if node_id:
            rows = await self._pool.fetch(
                """
                SELECT folder_id, COUNT(*)::int AS cnt
                FROM sessions
                WHERE node_id = $1
                GROUP BY folder_id
                """,
                node_id,
            )
        else:
            rows = await self._pool.fetch(
                """
                SELECT folder_id, COUNT(*)::int AS cnt
                FROM sessions
                GROUP BY folder_id
                """
            )
        return {row["folder_id"]: row["cnt"] for row in rows}

    async def delete_session(self, session_id: str) -> None:
        await self._pool.execute(
            "SELECT session_delete($1)", session_id
        )

    async def update_session_status(self, session_id: str, status: str) -> None:
        """세션 상태만 UPDATE한다. INSERT 없음, node_id 등 다른 필드 불변."""
        await self._pool.execute(
            "UPDATE sessions SET status = $1, updated_at = NOW() WHERE session_id = $2",
            status, session_id,
        )

    async def append_metadata(self, session_id: str, entry: dict) -> None:
        """세션에 메타데이터 엔트리를 원자적으로 추가한다."""
        now = _utc_now()
        entry_json = json.dumps([entry], ensure_ascii=False)

        searchable = f"{entry.get('type', '')}: {entry.get('value', '')} {entry.get('label', '')}"
        event_payload = json.dumps({
            "type": "metadata",
            "metadata_type": entry.get("type"),
            "value": entry.get("value"),
            "label": entry.get("label"),
        }, ensure_ascii=False)

        await self._pool.fetchval(
            "SELECT session_append_metadata($1, $2, $3, $4, $5, $6)",
            session_id, entry_json, "metadata", event_payload, searchable, now,
        )

    async def update_last_message(self, session_id: str, last_message: dict) -> None:
        now = _utc_now()
        await self._pool.execute(
            "SELECT session_update_last_message($1, $2, $3)",
            session_id, json.dumps(last_message, ensure_ascii=False), now,
        )

    async def update_away_summary(self, session_id: str, summary: str) -> None:
        now = _utc_now()
        await self._pool.execute(
            "UPDATE sessions SET away_summary = $1, updated_at = $2 WHERE session_id = $3",
            summary, now, session_id,
        )

    # --- 읽음 상태 관리 ---

    async def update_last_read_event_id(self, session_id: str, event_id: int) -> bool:
        result = await self._pool.fetchval(
            "SELECT session_update_read_position($1, $2)",
            session_id, event_id,
        )
        return result != "UPDATE 0"

    async def get_read_position(self, session_id: str) -> tuple[int, int]:
        row = await self._pool.fetchrow(
            "SELECT * FROM session_get_read_position($1)", session_id
        )
        if row is None:
            raise ValueError(f"Session not found: {session_id}")
        # 마이그레이션 과도기: 레거시 세션의 컬럼이 NULL일 수 있으므로 0으로 fallback
        return (row["last_event_id"] or 0, row["last_read_event_id"] or 0)

    async def mark_running_at_shutdown(self, session_ids: list[str] | None = None) -> None:
        if session_ids is not None:
            if not session_ids:
                return
            await self._pool.execute(
                "SELECT shutdown_mark_running($1::text[])", session_ids,
            )
        else:
            await self._pool.execute(
                "SELECT shutdown_mark_running(NULL::text[])"
            )

    async def get_shutdown_sessions(self) -> list[dict]:
        rows = await self._pool.fetch(
            "SELECT * FROM shutdown_get_sessions($1)", self._node_id
        )
        # shutdown_get_sessions은 SETOF sessions (SELECT *)를 반환하므로
        # last_message, metadata 등 JSONB 컬럼이 포함됨 → _deserialize_session() 적용
        return [_deserialize_session(r) for r in rows]

    async def repair_broken_read_positions(self) -> int:
        count = await self._pool.fetchval(
            "SELECT shutdown_repair_read_positions()"
        )
        if count:
            logger.info(f"Repaired {count} sessions with broken read positions")
        return count

    async def clear_shutdown_flags(self) -> None:
        await self._pool.execute(
            "SELECT shutdown_clear_flags($1)", self._node_id
        )
