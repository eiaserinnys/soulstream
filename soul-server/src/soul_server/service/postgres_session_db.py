"""
PostgresSessionDB - PostgreSQL 기반 세션 저장소

세션 메타데이터, 이벤트, 폴더 카탈로그를 PostgreSQL(asyncpg)로 관리한다.
기존 SQLite SessionDB를 대체한다.

asyncpg 네이티브 async, tsvector 전문검색.
"""

import json
import logging
from datetime import datetime, timezone
from collections.abc import AsyncGenerator
from typing import Optional

import asyncpg

logger = logging.getLogger(__name__)

_SESSION_COLUMNS = frozenset({
    "folder_id", "display_name", "session_type", "status",
    "prompt", "client_id", "claude_session_id", "last_message",
    "metadata", "was_running_at_shutdown",
    "last_event_id", "last_read_event_id",
    "created_at", "updated_at", "node_id",
})

_FOLDER_COLUMNS = frozenset({"name", "sort_order"})

# timestamptz 컬럼 — 문자열이면 datetime으로 자동 변환
_TIMESTAMP_COLUMNS = frozenset({"created_at", "updated_at"})

# JSONB 컬럼 목록 — Python dict ↔ PostgreSQL JSONB 자동 변환
_JSONB_COLUMNS = frozenset({"last_message", "metadata"})


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class PostgresSessionDB:
    """PostgreSQL 기반 세션 저장소"""

    DEFAULT_FOLDERS = {"claude": "⚙️ 클로드 코드 세션", "llm": "⚙️ LLM 세션"}

    def __init__(self, database_url: str, node_id: str):
        self._database_url = database_url
        self._node_id = node_id
        self._pool: Optional[asyncpg.Pool] = None

    @property
    def node_id(self) -> str:
        return self._node_id

    @property
    def pool(self) -> asyncpg.Pool:
        """연결 풀 반환. connect() 전 호출 시 RuntimeError."""
        if self._pool is None:
            raise RuntimeError("connect()를 먼저 호출하세요")
        return self._pool

    async def connect(self) -> None:
        """연결 풀 생성 및 검증. 실패 시 예외 → 서버 기동 중단."""
        self._pool = await asyncpg.create_pool(
            self._database_url,
            min_size=2,
            max_size=10,
            command_timeout=30,
        )
        async with self._pool.acquire() as conn:
            await conn.execute("SELECT 1")
        await self._apply_schema()
        logger.info("PostgreSQL connection pool established")

    async def _apply_schema(self) -> None:
        """DDL 정본 파일을 실행하여 스키마와 프로시저를 배포한다.

        실패 시 예외 → 서버 기동 중단.
        """
        from pathlib import Path

        schema_path = (
            Path(__file__).resolve().parent.parent.parent.parent / "sql" / "schema.sql"
        )
        sql = schema_path.read_text(encoding="utf-8")
        await self._pool.execute(sql)
        logger.info("Schema and procedures deployed from %s", schema_path.name)

    async def close(self) -> None:
        if self._pool:
            await self._pool.close()

    # --- 세션 CRUD ---

    async def upsert_session(self, session_id: str, **fields) -> None:
        invalid = set(fields) - _SESSION_COLUMNS
        if invalid:
            raise ValueError(f"Invalid session columns: {invalid}")

        # node_id 자동 설정
        if "node_id" not in fields:
            fields["node_id"] = self._node_id

        # JSONB 컬럼은 JSON 문자열로 직렬화
        for col in _JSONB_COLUMNS:
            if col in fields and isinstance(fields[col], (dict, list)):
                fields[col] = json.dumps(fields[col], ensure_ascii=False)

        # timestamptz 컬럼: 문자열이면 datetime으로 변환 (asyncpg 요구)
        for col in _TIMESTAMP_COLUMNS:
            if col in fields and isinstance(fields[col], str):
                fields[col] = datetime.fromisoformat(fields[col])

        now = _utc_now()
        fields.setdefault("created_at", now)
        fields.setdefault("updated_at", now)
        fields["session_id"] = session_id

        cols = list(fields.keys())
        placeholders = ", ".join(f"${i+1}" for i in range(len(cols)))
        col_names = ", ".join(cols)

        # UPDATE 대상: session_id, created_at 제외 — EXCLUDED 참조로 파라미터 한 벌만 전달
        update_cols = [c for c in cols if c not in ("session_id", "created_at")]
        set_clause = ", ".join(f"{c} = EXCLUDED.{c}" for c in update_cols)

        await self._pool.execute(
            f"INSERT INTO sessions ({col_names}) VALUES ({placeholders}) "
            f"ON CONFLICT (session_id) DO UPDATE SET {set_clause}",
            *[fields[c] for c in cols],
        )

    @staticmethod
    def _deserialize_session(row: asyncpg.Record) -> dict:
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

    async def get_session(self, session_id: str) -> Optional[dict]:
        row = await self._pool.fetchrow(
            "SELECT * FROM sessions WHERE session_id = $1", session_id
        )
        if row is None:
            return None
        return self._deserialize_session(row)

    async def get_all_sessions(
        self, offset: int = 0, limit: int = 0, session_type: Optional[str] = None
    ) -> tuple[list[dict], int]:
        where_parts = []
        params = []
        idx = 1

        if session_type:
            where_parts.append(f"session_type = ${idx}")
            params.append(session_type)
            idx += 1

        where = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""

        total = await self._pool.fetchval(
            f"SELECT COUNT(*) FROM sessions {where}", *params
        )

        sql = f"SELECT * FROM sessions {where} ORDER BY updated_at DESC"
        query_params = list(params)

        if limit > 0:
            sql += f" LIMIT ${idx} OFFSET ${idx+1}"
            query_params.extend([limit, offset])
        elif offset > 0:
            sql += f" OFFSET ${idx}"
            query_params.append(offset)

        rows = await self._pool.fetch(sql, *query_params)
        return [self._deserialize_session(r) for r in rows], total

    async def delete_session(self, session_id: str) -> None:
        await self._pool.execute(
            "DELETE FROM sessions WHERE session_id = $1", session_id
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

        async with self._pool.acquire() as conn:
            async with conn.transaction():
                # 행 잠금으로 동시 append_event와의 ID 충돌 방지
                row = await conn.fetchval(
                    "SELECT session_id FROM sessions WHERE session_id = $1 FOR UPDATE",
                    session_id,
                )
                if row is None:
                    raise ValueError(f"Session not found: {session_id}")

                # 메타데이터 JSONB 배열 append
                await conn.execute(
                    "UPDATE sessions "
                    "SET metadata = COALESCE(metadata, '[]'::jsonb) || $1::jsonb, "
                    "    updated_at = $2 "
                    "WHERE session_id = $3",
                    entry_json, now, session_id,
                )

                # 이벤트 삽입 + ID 회수
                event_id = await conn.fetchval(
                    "INSERT INTO events (id, session_id, event_type, payload, searchable_text, created_at) "
                    "VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM events WHERE session_id = $1), "
                    "$1, $2, $3, $4, $5) RETURNING id",
                    session_id, "metadata", event_payload, searchable, now,
                )

                # last_event_id 갱신 (append_event와 동일 패턴)
                await conn.execute(
                    "UPDATE sessions SET last_event_id = $1 WHERE session_id = $2",
                    event_id, session_id,
                )

    async def update_last_message(self, session_id: str, last_message: dict) -> None:
        now = _utc_now()
        await self._pool.execute(
            "UPDATE sessions SET last_message = $1, updated_at = $2 WHERE session_id = $3",
            json.dumps(last_message, ensure_ascii=False), now, session_id,
        )

    # --- 읽음 상태 관리 ---

    async def update_last_read_event_id(self, session_id: str, event_id: int) -> bool:
        result = await self._pool.execute(
            "UPDATE sessions SET last_read_event_id = $1 WHERE session_id = $2",
            event_id, session_id,
        )
        return result != "UPDATE 0"

    async def get_read_position(self, session_id: str) -> tuple[int, int]:
        row = await self._pool.fetchrow(
            "SELECT last_event_id, last_read_event_id FROM sessions WHERE session_id = $1",
            session_id,
        )
        if row is None:
            raise ValueError(f"Session not found: {session_id}")
        # 마이그레이션 과도기: 레거시 세션의 컬럼이 NULL일 수 있으므로 0으로 fallback
        return (row["last_event_id"] or 0, row["last_read_event_id"] or 0)

    async def mark_running_at_shutdown(self, session_ids: list[str] | None = None) -> None:
        if session_ids is not None:
            if not session_ids:
                return
            placeholders = ", ".join(f"${i+1}" for i in range(len(session_ids)))
            await self._pool.execute(
                f"UPDATE sessions SET was_running_at_shutdown = TRUE WHERE session_id IN ({placeholders})",
                *session_ids,
            )
        else:
            await self._pool.execute(
                "UPDATE sessions SET was_running_at_shutdown = TRUE WHERE status = 'running'"
            )

    async def get_shutdown_sessions(self) -> list[dict]:
        rows = await self._pool.fetch(
            "SELECT * FROM sessions WHERE was_running_at_shutdown = TRUE"
        )
        return [dict(r) for r in rows]

    async def repair_broken_read_positions(self) -> int:
        result = await self._pool.execute("""
            UPDATE sessions
            SET last_read_event_id = last_event_id
            WHERE status != 'running'
              AND last_read_event_id < last_event_id
        """)
        count = int(result.split()[-1]) if result else 0
        if count:
            logger.info(f"Repaired {count} sessions with broken read positions")
        return count

    async def clear_shutdown_flags(self) -> None:
        await self._pool.execute(
            "UPDATE sessions SET was_running_at_shutdown = FALSE WHERE was_running_at_shutdown = TRUE"
        )

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

        ID 할당과 INSERT를 단일 트랜잭션에서 수행하여
        동시 호출 시 ID 충돌을 방지한다.
        """
        # created_at이 ISO 문자열이면 timestamptz로 변환
        if isinstance(created_at, str):
            try:
                created_at = datetime.fromisoformat(created_at)
            except ValueError:
                created_at = _utc_now()

        async with self._pool.acquire() as conn:
            async with conn.transaction():
                # 세션 행에 행 잠금을 걸어 같은 세션에 대한 동시 append를 직렬화한다.
                # Read Committed에서 SELECT MAX(id)+1 서브쿼리의 동시 읽기로
                # 중복 ID가 생기는 것을 방지한다.
                await conn.fetchval(
                    "SELECT session_id FROM sessions WHERE session_id = $1 FOR UPDATE",
                    session_id,
                )
                event_id = await conn.fetchval(
                    "INSERT INTO events (id, session_id, event_type, payload, searchable_text, created_at) "
                    "VALUES ("
                    "  (SELECT COALESCE(MAX(id), 0) + 1 FROM events WHERE session_id = $1),"
                    "  $1, $2, $3, $4, $5"
                    ") RETURNING id",
                    session_id, event_type, payload, searchable_text, created_at,
                )
                await conn.execute(
                    "UPDATE sessions SET last_event_id = $1 WHERE session_id = $2",
                    event_id, session_id,
                )
                return event_id

    async def read_events(self, session_id: str, after_id: int = 0) -> list[dict]:
        rows = await self._pool.fetch(
            "SELECT id, session_id, event_type, payload, searchable_text, created_at "
            "FROM events WHERE session_id = $1 AND id > $2 ORDER BY id",
            session_id, after_id,
        )
        return [self._event_to_dict(r) for r in rows]

    async def stream_events_raw(
        self, session_id: str, after_id: int = 0,
    ) -> AsyncGenerator[tuple[int, str, str], None]:
        """이벤트를 (id, event_type, payload_text) 튜플로 스트리밍.

        payload를 파싱하지 않고 raw JSON text로 반환한다.
        asyncpg cursor를 사용하여 행 단위로 yield한다.
        """
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                async for row in conn.cursor(
                    "SELECT id, event_type, payload::text as payload_text "
                    "FROM events WHERE session_id = $1 AND id > $2 ORDER BY id",
                    session_id, after_id,
                ):
                    yield row["id"], row["event_type"], row["payload_text"]

    async def read_one_event(self, session_id: str, event_id: int) -> Optional[dict]:
        row = await self._pool.fetchrow(
            "SELECT id, session_id, event_type, payload, searchable_text, created_at "
            "FROM events WHERE session_id = $1 AND id = $2",
            session_id, event_id,
        )
        return self._event_to_dict(row) if row else None


    async def count_events(self, session_id: str) -> int:
        return await self._pool.fetchval(
            "SELECT COUNT(*) FROM events WHERE session_id = $1", session_id
        )

    @staticmethod
    def _event_to_dict(row: asyncpg.Record) -> dict:
        d = dict(row)
        # payload: JSONB → 이미 Python dict이지만 호출자는 str을 기대할 수 있음
        # created_at: datetime → ISO string
        if isinstance(d.get("created_at"), datetime):
            d["created_at"] = d["created_at"].isoformat()
        # payload가 dict/list면 JSON 문자열로 변환 (기존 호출자 호환)
        if isinstance(d.get("payload"), (dict, list)):
            d["payload"] = json.dumps(d["payload"], ensure_ascii=False)
        return d

    # --- 폴더 CRUD ---

    async def create_folder(self, folder_id: str, name: str, sort_order: int = 0) -> None:
        await self._pool.execute(
            "INSERT INTO folders (id, name, sort_order) VALUES ($1, $2, $3)",
            folder_id, name, sort_order,
        )

    async def update_folder(self, folder_id: str, **fields) -> None:
        if not fields:
            return
        invalid = set(fields) - _FOLDER_COLUMNS
        if invalid:
            raise ValueError(f"Invalid folder columns: {invalid}")

        set_parts = []
        values = []
        idx = 1
        for k, v in fields.items():
            set_parts.append(f"{k} = ${idx}")
            values.append(v)
            idx += 1
        values.append(folder_id)

        await self._pool.execute(
            f"UPDATE folders SET {', '.join(set_parts)} WHERE id = ${idx}",
            *values,
        )

    async def get_folder(self, folder_id: str) -> Optional[dict]:
        row = await self._pool.fetchrow(
            "SELECT * FROM folders WHERE id = $1", folder_id
        )
        return dict(row) if row else None

    async def delete_folder(self, folder_id: str) -> None:
        await self._pool.execute("DELETE FROM folders WHERE id = $1", folder_id)

    async def get_all_folders(self) -> list[dict]:
        rows = await self._pool.fetch(
            "SELECT * FROM folders ORDER BY sort_order, name"
        )
        return [dict(r) for r in rows]

    async def get_default_folder(self, name: str) -> Optional[dict]:
        row = await self._pool.fetchrow(
            "SELECT * FROM folders WHERE name = $1", name
        )
        return dict(row) if row else None

    async def ensure_default_folders(self) -> None:
        for folder_id, name in self.DEFAULT_FOLDERS.items():
            await self._pool.execute(
                "INSERT INTO folders (id, name, sort_order) VALUES ($1, $2, $3) "
                "ON CONFLICT (id) DO NOTHING",
                folder_id, name, 0,
            )

    async def ensure_indexes(self) -> None:
        """히스토리 조회에 필요한 인덱스를 보장한다."""
        await self._pool.execute(
            "CREATE INDEX IF NOT EXISTS idx_events_session_id_id "
            "ON events (session_id, id)"
        )

    # --- 카탈로그 ---

    async def assign_session_to_folder(
        self, session_id: str, folder_id: Optional[str]
    ) -> None:
        await self._pool.execute(
            "UPDATE sessions SET folder_id = $1 WHERE session_id = $2",
            folder_id, session_id,
        )

    async def rename_session(self, session_id: str, display_name: Optional[str]) -> None:
        await self._pool.execute(
            "UPDATE sessions SET display_name = $1 WHERE session_id = $2",
            display_name, session_id,
        )

    async def get_catalog(self) -> dict:
        folders = await self.get_all_folders()
        folder_list = [
            {"id": f["id"], "name": f["name"], "sortOrder": f["sort_order"]}
            for f in folders
        ]

        rows = await self._pool.fetch(
            "SELECT session_id, folder_id, display_name FROM sessions"
        )
        sessions = {}
        for r in rows:
            sessions[r["session_id"]] = {
                "folderId": r["folder_id"],
                "displayName": r["display_name"],
            }

        return {"folders": folder_list, "sessions": sessions}

    # --- 전문검색 (tsvector) ---

    async def search_events(
        self,
        query: str,
        session_ids: Optional[list[str]] = None,
        limit: int = 50,
    ) -> list[dict]:
        if not query.strip():
            return []

        idx = 1
        params = []

        if session_ids:
            sid_placeholders = ", ".join(f"${i+2}" for i in range(len(session_ids)))
            sql = (
                "SELECT e.id, e.session_id, e.event_type, e.payload, "
                "e.searchable_text, e.created_at "
                "FROM events e "
                f"WHERE e.search_vector @@ plainto_tsquery('simple', $1) "
                f"AND e.session_id IN ({sid_placeholders}) "
                "ORDER BY ts_rank(e.search_vector, plainto_tsquery('simple', $1)) DESC "
                f"LIMIT ${len(session_ids)+2}"
            )
            params = [query, *session_ids, limit]
        else:
            sql = (
                "SELECT e.id, e.session_id, e.event_type, e.payload, "
                "e.searchable_text, e.created_at "
                "FROM events e "
                "WHERE e.search_vector @@ plainto_tsquery('simple', $1) "
                "ORDER BY ts_rank(e.search_vector, plainto_tsquery('simple', $1)) DESC "
                "LIMIT $2"
            )
            params = [query, limit]

        try:
            rows = await self._pool.fetch(sql, *params)
            return [self._event_to_dict(r) for r in rows]
        except asyncpg.PostgresError as e:
            logger.warning(f"tsvector search failed: {e}")
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


# === 싱글턴 인스턴스 관리 ===

_session_db: Optional[PostgresSessionDB] = None


def init_session_db(db: PostgresSessionDB) -> None:
    """PostgresSessionDB 전역 인스턴스 설정"""
    global _session_db
    _session_db = db


def get_session_db() -> PostgresSessionDB:
    """PostgresSessionDB 전역 인스턴스 반환"""
    if _session_db is None:
        raise RuntimeError("PostgresSessionDB not initialized.")
    return _session_db
