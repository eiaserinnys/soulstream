"""
SqliteSessionDB - SQLite 기반 세션 저장소

로컬 모드(DATABASE_URL 미설정)에서 PostgresSessionDB 대신 사용한다.
aiosqlite(단일 연결)로 세션 메타데이터, 이벤트, 폴더를 관리한다.

PostgreSQL 저장 프로시저(session_upsert 등)에 상응하는 직접 SQL 쿼리를 인라인으로 구현한다.
타입 매핑:
  JSONB      → TEXT (json.dumps / json.loads)
  TIMESTAMPTZ → TEXT (ISO 8601 문자열)
  BOOLEAN    → INTEGER (0 / 1)

⚠️  DB 어댑터 동기화 규칙 ⚠️
이 파일(SqliteSessionDB)과 session_db.py(PostgresSessionDB)는
항상 동일한 공개 인터페이스를 유지해야 한다.

메서드를 추가·삭제·시그니처 변경할 때는 반드시 두 파일을 동시에 수정한다.
한쪽만 바꾸면 로컬 모드(SQLite)와 프로덕션 모드(PostgreSQL)의 동작이 달라진다.

  이 파일 변경 → session_db.py 도 반드시 확인
"""

import asyncio
import json
import logging
from collections.abc import AsyncGenerator
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Union

import aiosqlite

logger = logging.getLogger(__name__)

_SESSION_COLUMNS = frozenset({
    "folder_id", "display_name", "session_type", "status",
    "prompt", "client_id", "claude_session_id", "last_message",
    "metadata", "was_running_at_shutdown",
    "last_event_id", "last_read_event_id",
    "created_at", "updated_at", "node_id", "agent_id",
})

_FOLDER_COLUMNS = frozenset({"name", "sort_order", "settings"})

# 폴더 컬럼 중 JSONB 직렬화가 필요한 컬럼 (SQLite TEXT 저장)
_FOLDER_JSONB_COLUMNS = frozenset({"settings"})

_JSONB_COLUMNS = frozenset({"last_message", "metadata"})
_TIMESTAMP_COLUMNS = frozenset({"created_at", "updated_at"})

# 최초 설정 이후 덮어쓸 수 없는 식별 필드
IMMUTABLE_FIELDS: frozenset[str] = frozenset({"claude_session_id", "node_id", "agent_id"})


def _utc_now() -> str:
    """현재 UTC 시각을 ISO 8601 문자열로 반환한다."""
    return datetime.now(timezone.utc).isoformat()


def _to_iso(v) -> Optional[str]:
    """datetime 또는 ISO 문자열을 ISO 문자열로 정규화한다."""
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v)


def _serialize_field(col: str, v) -> Optional[str]:
    """세션 컬럼 값을 SQLite 저장 형식(TEXT/INTEGER)으로 직렬화한다."""
    if v is None:
        return None
    if col in _JSONB_COLUMNS:
        if isinstance(v, (dict, list)):
            return json.dumps(v, ensure_ascii=False)
        return str(v)
    if col in _TIMESTAMP_COLUMNS:
        return _to_iso(v)
    if col == "was_running_at_shutdown":
        return 1 if v else 0
    return v


def _deserialize_session(row: aiosqlite.Row) -> dict:
    """SQLite Row를 Python dict으로 역직렬화한다."""
    d = dict(row)
    for field in _JSONB_COLUMNS:
        if isinstance(d.get(field), str):
            try:
                d[field] = json.loads(d[field])
            except (json.JSONDecodeError, TypeError):
                pass
    if "was_running_at_shutdown" in d:
        d["was_running_at_shutdown"] = bool(d["was_running_at_shutdown"])
    return d


def _event_to_dict(row: aiosqlite.Row) -> dict:
    """이벤트 Row를 dict으로 변환한다."""
    return dict(row)


class SqliteSessionDB:
    """SQLite 기반 세션 저장소.

    Args:
        db_path: SQLite 파일 경로
        node_id: 노드 식별자. None이면 전역 뷰
        schema_path: DDL 파일 경로. None이면 스키마 배포 생략
    """

    DEFAULT_FOLDERS = {"claude": "⚙️ 클로드 코드 세션", "llm": "⚙️ LLM 세션"}

    def __init__(
        self,
        db_path: Union[str, Path],
        node_id: Optional[str] = None,
        schema_path: Optional[Path] = None,
    ):
        self._db_path = str(db_path)
        self._node_id = node_id
        self._schema_path = schema_path
        self._conn: Optional[aiosqlite.Connection] = None
        # append_event 동시성 제어: session_id → asyncio.Lock
        self._session_locks: dict[str, asyncio.Lock] = {}
        self._locks_mutex = asyncio.Lock()

    @property
    def node_id(self) -> Optional[str]:
        return self._node_id

    @property
    def conn(self) -> aiosqlite.Connection:
        """연결 반환. connect() 전 호출 시 RuntimeError."""
        if self._conn is None:
            raise RuntimeError("connect()를 먼저 호출하세요")
        return self._conn

    async def _get_session_lock(self, session_id: str) -> asyncio.Lock:
        """세션별 Lock을 가져오거나 생성한다."""
        async with self._locks_mutex:
            if session_id not in self._session_locks:
                self._session_locks[session_id] = asyncio.Lock()
            return self._session_locks[session_id]

    async def connect(self) -> None:
        """SQLite 연결을 열고 스키마를 적용한다."""
        self._conn = await aiosqlite.connect(self._db_path)
        self._conn.row_factory = aiosqlite.Row
        # 외래키 제약 활성화 및 WAL 모드 (동시 읽기 성능 개선)
        await self._conn.execute("PRAGMA foreign_keys = ON")
        await self._conn.execute("PRAGMA journal_mode = WAL")
        await self._conn.commit()
        if self._schema_path is not None:
            await self._apply_schema()
        logger.info("SQLite connection established: %s", self._db_path)

    async def _apply_schema(self) -> None:
        """DDL 파일을 실행하여 테이블과 인덱스를 생성한다."""
        if self._schema_path is None:
            return
        sql = self._schema_path.read_text(encoding="utf-8")
        await self._conn.executescript(sql)
        await self._conn.commit()
        logger.info("SQLite schema applied from %s", self._schema_path.name)
        await self._migrate_schema()

    async def _migrate_schema(self) -> None:
        """기존 테이블에 새 컬럼을 추가하는 마이그레이션 (멱등).

        SQLite는 ALTER TABLE ... ADD COLUMN IF NOT EXISTS를 지원하지 않으므로
        예외를 무시하는 방식으로 멱등성을 확보한다.
        """
        try:
            await self._conn.execute(
                "ALTER TABLE folders ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'"
            )
            await self._conn.commit()
        except Exception:
            # 컬럼이 이미 존재하면 "duplicate column name" 오류 → 무시
            pass

    async def close(self) -> None:
        if self._conn:
            await self._conn.close()
            self._conn = None

    # --- 세션 CRUD ---

    async def upsert_session(self, session_id: str, **fields) -> None:
        invalid = set(fields) - _SESSION_COLUMNS
        if invalid:
            raise ValueError(f"Invalid session columns: {invalid}")

        # 불변 필드 보호: None 포함 모든 덮어쓰기 시도 시 기존 값 확인 후 충돌 방지
        immutable_updates = {k: v for k, v in fields.items() if k in IMMUTABLE_FIELDS}
        if immutable_updates:
            cursor = await self._conn.execute(
                "SELECT claude_session_id, node_id, agent_id FROM sessions WHERE session_id = ?",
                (session_id,),
            )
            row = await cursor.fetchone()
            if row:
                existing = dict(row)
                for field, new_val in immutable_updates.items():
                    old_val = existing.get(field)
                    if old_val is not None and old_val != new_val:
                        raise ValueError(
                            f"Immutable field '{field}' already set to {old_val!r}, "
                            f"cannot overwrite with {new_val!r}"
                        )

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
        agent_id: str,
        claude_session_id: str,
        session_type: str,
        prompt: Optional[str] = None,
        client_id: Optional[str] = None,
        status: str = "running",
        created_at=None,
        updated_at=None,
    ) -> None:
        """세션 최초 등록 (순수 INSERT).

        4개 불변 ID(session_id, node_id, agent_id, claude_session_id)를 원자적으로 기록한다.
        중복 호출 시 UNIQUE 제약 위반 예외 발생 (INSERT OR IGNORE 없음).
        """
        now = _utc_now()
        await self._conn.execute(
            """INSERT INTO sessions
               (session_id, node_id, agent_id, claude_session_id,
                session_type, prompt, client_id, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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
            ),
        )
        await self._conn.commit()

    _UPDATE_SESSION_IMMUTABLE = frozenset({
        "node_id", "agent_id", "claude_session_id", "session_type", "created_at",
    })

    async def update_session(self, session_id: str, **fields) -> None:
        """세션 속성 갱신 (순수 UPDATE).

        불변 필드(node_id, agent_id, claude_session_id, session_type, created_at)는
        허용하지 않는다 — ValueError를 발생시킨다.
        """
        invalid = set(fields) & self._UPDATE_SESSION_IMMUTABLE
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

    # --- 이벤트 CRUD ---

    async def append_event(
        self,
        session_id: str,
        event_type: str,
        payload: str,
        searchable_text: str,
        created_at: str,
    ) -> int:
        """이벤트를 원자적으로 저장하고 할당된 event_id를 반환한다.

        per-session Lock으로 event_id 채번의 원자성을 보장한다.
        (SQLite는 행 단위 FOR UPDATE를 지원하지 않으므로 asyncio.Lock 사용)
        """
        lock = await self._get_session_lock(session_id)
        async with lock:
            # 다음 event_id 채번 (max + 1, 없으면 1)
            cursor = await self._conn.execute(
                "SELECT COALESCE(MAX(id), 0) + 1 FROM events WHERE session_id = ?",
                (session_id,),
            )
            event_id = (await cursor.fetchone())[0]

            await self._conn.execute(
                "INSERT INTO events (session_id, id, event_type, payload, searchable_text, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (session_id, event_id, event_type, payload, searchable_text, created_at),
            )

            # FTS5 독립 테이블에 색인 추가
            if searchable_text:
                await self._conn.execute(
                    "INSERT INTO events_fts (searchable_text, session_id, event_id)"
                    " VALUES (?, ?, ?)",
                    (searchable_text, session_id, event_id),
                )

            # 세션의 last_event_id 갱신
            await self._conn.execute(
                "UPDATE sessions SET last_event_id = ?, updated_at = ? WHERE session_id = ?",
                (event_id, _utc_now(), session_id),
            )

            await self._conn.commit()
            return event_id

    async def read_events(
        self,
        session_id: str,
        after_id: int = 0,
        limit: int | None = None,
        event_types: list[str] | None = None,
    ) -> list[dict]:
        where = "session_id = ? AND id > ?"
        params: list = [session_id, after_id]

        if event_types:
            placeholders = ", ".join("?" * len(event_types))
            where += f" AND event_type IN ({placeholders})"
            params.extend(event_types)

        sql = f"SELECT * FROM events WHERE {where} ORDER BY id ASC"
        if limit is not None and limit > 0:
            sql += f" LIMIT {int(limit)}"

        cursor = await self._conn.execute(sql, params)
        rows = await cursor.fetchall()
        return [_event_to_dict(r) for r in rows]

    async def stream_events_raw(
        self,
        session_id: str,
        after_id: int = 0,
    ) -> AsyncGenerator[tuple[int, str, str], None]:
        """이벤트를 (id, event_type, payload) 튜플로 스트리밍."""
        cursor = await self._conn.execute(
            "SELECT id, event_type, payload FROM events"
            " WHERE session_id = ? AND id > ? ORDER BY id ASC",
            (session_id, after_id),
        )
        async for row in cursor:
            yield row[0], row[1], row[2]

    async def read_one_event(self, session_id: str, event_id: int) -> Optional[dict]:
        cursor = await self._conn.execute(
            "SELECT * FROM events WHERE session_id = ? AND id = ?",
            (session_id, event_id),
        )
        row = await cursor.fetchone()
        return _event_to_dict(row) if row else None

    async def count_events(self, session_id: str) -> int:
        cursor = await self._conn.execute(
            "SELECT COUNT(*) FROM events WHERE session_id = ?", (session_id,)
        )
        return (await cursor.fetchone())[0]

    # --- 폴더 CRUD ---

    async def create_folder(self, folder_id: str, name: str, sort_order: int = 0) -> None:
        await self._conn.execute(
            "INSERT OR IGNORE INTO folders (id, name, sort_order) VALUES (?, ?, ?)",
            (folder_id, name, sort_order),
        )
        await self._conn.commit()

    async def update_folder(self, folder_id: str, **fields) -> None:
        if not fields:
            return
        invalid = set(fields) - _FOLDER_COLUMNS
        if invalid:
            raise ValueError(f"Invalid folder columns: {invalid}")
        set_clauses = ", ".join(f"{c} = ?" for c in fields)
        vals = [
            json.dumps(v, ensure_ascii=False) if k in _FOLDER_JSONB_COLUMNS else v
            for k, v in fields.items()
        ] + [folder_id]
        await self._conn.execute(
            f"UPDATE folders SET {set_clauses} WHERE id = ?", vals
        )
        await self._conn.commit()

    async def get_folder(self, folder_id: str) -> Optional[dict]:
        cursor = await self._conn.execute(
            "SELECT * FROM folders WHERE id = ?", (folder_id,)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def delete_folder(self, folder_id: str) -> None:
        await self._conn.execute(
            "DELETE FROM folders WHERE id = ?", (folder_id,)
        )
        await self._conn.commit()

    async def get_all_folders(self) -> list[dict]:
        cursor = await self._conn.execute(
            "SELECT * FROM folders ORDER BY sort_order ASC"
        )
        rows = await cursor.fetchall()
        result = []
        for r in rows:
            d = dict(r)
            if "settings" in d and isinstance(d["settings"], str):
                try:
                    d["settings"] = json.loads(d["settings"])
                except Exception:
                    d["settings"] = {}
            result.append(d)
        return result

    async def get_default_folder(self, name: str) -> Optional[dict]:
        """DEFAULT_FOLDERS에 정의된 기본 폴더를 name으로 조회한다."""
        # name으로 역참조
        for fid, fname in self.DEFAULT_FOLDERS.items():
            if fname == name:
                return await self.get_folder(fid)
        return None

    async def ensure_default_folders(self) -> None:
        for fid, fname in self.DEFAULT_FOLDERS.items():
            await self._conn.execute(
                "INSERT OR IGNORE INTO folders (id, name, sort_order) VALUES (?, ?, ?)",
                (fid, fname, 0),
            )
        await self._conn.commit()

    async def ensure_indexes(self) -> None:
        """No-op. 인덱스는 schema.sql에서 DDL로 관리한다."""
        pass

    # --- 카탈로그 ---

    async def assign_session_to_folder(
        self, session_id: str, folder_id: Optional[str]
    ) -> None:
        await self._conn.execute(
            "UPDATE sessions SET folder_id = ?, updated_at = ? WHERE session_id = ?",
            (folder_id, _utc_now(), session_id),
        )
        await self._conn.commit()

    async def rename_session(self, session_id: str, display_name: Optional[str]) -> None:
        await self._conn.execute(
            "UPDATE sessions SET display_name = ?, updated_at = ? WHERE session_id = ?",
            (display_name, _utc_now(), session_id),
        )
        await self._conn.commit()

    async def get_catalog(self) -> dict:
        folders = await self.get_all_folders()
        folder_list = [
            {
                "id": f["id"],
                "name": f["name"],
                "sortOrder": f["sort_order"],
                "settings": f.get("settings") or {},
            }
            for f in folders
        ]

        cursor = await self._conn.execute(
            "SELECT session_id, folder_id, display_name FROM sessions"
        )
        rows = await cursor.fetchall()
        sessions = {
            r["session_id"]: {
                "folderId": r["folder_id"],
                "displayName": r["display_name"],
            }
            for r in rows
        }
        return {"folders": folder_list, "sessions": sessions}

    # --- 경량 세션 목록 ---

    async def list_sessions_summary(
        self,
        search: str | None = None,
        session_type: str | None = None,
        limit: int = 20,
        offset: int = 0,
        folder_id: str | None = None,
        node_id: str | None = None,
    ) -> tuple[list[dict], int]:
        """경량 세션 목록과 total count를 반환한다.

        search가 주어지면 FTS5로 이벤트 텍스트를 검색하여 매칭 세션만 반환한다.
        """
        if search and search.strip():
            return await self._list_sessions_summary_with_search(
                search, session_type, limit, offset, folder_id, node_id
            )

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
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""

        count_cursor = await self._conn.execute(
            f"SELECT COUNT(*) FROM sessions{where}", params
        )
        total = (await count_cursor.fetchone())[0]
        if total == 0:
            return [], 0

        summary_cols = (
            "session_id, display_name, session_type, status, folder_id,"
            " node_id, last_message, last_event_id, last_read_event_id,"
            " created_at, updated_at"
        )
        data_sql = (
            f"SELECT {summary_cols} FROM sessions{where}"
            f" ORDER BY updated_at DESC LIMIT ? OFFSET ?"
        )
        cursor = await self._conn.execute(data_sql, params + [limit, offset])
        rows = await cursor.fetchall()

        sessions = []
        for r in rows:
            d = dict(r)
            if isinstance(d.get("last_message"), str):
                try:
                    d["last_message"] = json.loads(d["last_message"])
                except (json.JSONDecodeError, TypeError):
                    pass
            sessions.append(d)

        return sessions, total

    async def _list_sessions_summary_with_search(
        self,
        search: str,
        session_type: str | None,
        limit: int,
        offset: int,
        folder_id: str | None,
        node_id: str | None,
    ) -> tuple[list[dict], int]:
        """FTS5 검색 결과로 세션 목록을 반환한다."""
        # FTS5 검색으로 매칭 session_id 목록 조회
        fts_cursor = await self._conn.execute(
            "SELECT DISTINCT session_id FROM events_fts WHERE searchable_text MATCH ?",
            (search,),
        )
        fts_rows = await fts_cursor.fetchall()
        matched_ids = [r[0] for r in fts_rows]
        if not matched_ids:
            return [], 0

        placeholders = ", ".join("?" * len(matched_ids))
        clauses = [f"session_id IN ({placeholders})"]
        params: list = list(matched_ids)

        if session_type:
            clauses.append("session_type = ?")
            params.append(session_type)
        if folder_id:
            clauses.append("folder_id = ?")
            params.append(folder_id)
        if node_id:
            clauses.append("node_id = ?")
            params.append(node_id)

        where = " WHERE " + " AND ".join(clauses)

        count_cursor = await self._conn.execute(
            f"SELECT COUNT(*) FROM sessions{where}", params
        )
        total = (await count_cursor.fetchone())[0]
        if total == 0:
            return [], 0

        summary_cols = (
            "session_id, display_name, session_type, status, folder_id,"
            " node_id, last_message, last_event_id, last_read_event_id,"
            " created_at, updated_at"
        )
        data_sql = (
            f"SELECT {summary_cols} FROM sessions{where}"
            f" ORDER BY updated_at DESC LIMIT ? OFFSET ?"
        )
        cursor = await self._conn.execute(data_sql, params + [limit, offset])
        rows = await cursor.fetchall()

        sessions = []
        for r in rows:
            d = dict(r)
            if isinstance(d.get("last_message"), str):
                try:
                    d["last_message"] = json.loads(d["last_message"])
                except (json.JSONDecodeError, TypeError):
                    pass
            sessions.append(d)

        return sessions, total

    # --- 전문검색 (FTS5) ---

    async def search_events(
        self,
        query: str,
        session_ids: Optional[list[str]] = None,
        limit: int = 50,
    ) -> list[dict]:
        if not query.strip():
            return []

        try:
            if session_ids is not None:
                if not session_ids:
                    return []
                placeholders = ", ".join("?" * len(session_ids))
                cursor = await self._conn.execute(
                    f"SELECT session_id, event_id FROM events_fts"
                    f" WHERE searchable_text MATCH ? AND session_id IN ({placeholders})"
                    f" LIMIT ?",
                    [query] + list(session_ids) + [limit],
                )
            else:
                cursor = await self._conn.execute(
                    "SELECT session_id, event_id FROM events_fts"
                    " WHERE searchable_text MATCH ? LIMIT ?",
                    (query, limit),
                )

            fts_rows = await cursor.fetchall()
            if not fts_rows:
                return []

            # 이벤트 역참조
            results = []
            for r in fts_rows:
                sid, eid = r[0], r[1]
                event = await self.read_one_event(sid, eid)
                if event:
                    results.append(event)
            return results

        except Exception as e:
            logger.warning("FTS5 search failed: %s", e)
            return []

    # --- searchable_text 추출 유틸 ---

    @staticmethod
    def extract_searchable_text(event: dict) -> str:
        event_type = event.get("type")
        if event_type == "text_delta":
            return event.get("text", "")
        elif event_type == "thinking":
            return event.get("thinking", "")
        elif event_type in ("tool_use", "tool_start"):
            inp = event.get("input") or event.get("tool_input")
            if isinstance(inp, str):
                return inp
            if isinstance(inp, dict):
                return json.dumps(inp, ensure_ascii=False)
        elif event_type == "tool_result":
            content = event.get("result") or event.get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                texts = [c.get("text", "") for c in content if isinstance(c, dict)]
                return " ".join(filter(None, texts))
        elif event_type in ("user", "user_message"):
            text = event.get("text") or event.get("content")
            if isinstance(text, str):
                return text
            if isinstance(text, list):
                texts = [c.get("text", "") for c in text if isinstance(c, dict)]
                return " ".join(filter(None, texts))
        return ""
