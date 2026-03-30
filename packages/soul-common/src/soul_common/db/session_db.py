"""
PostgresSessionDB - PostgreSQL 기반 세션 저장소

세션 메타데이터, 이벤트, 폴더 카탈로그를 PostgreSQL(asyncpg)로 관리한다.

asyncpg 네이티브 async, tsvector 전문검색.
모든 쿼리는 schema.sql에 정의된 프로시저/함수를 호출한다.

⚠️  DB 어댑터 동기화 규칙 ⚠️
이 파일(PostgresSessionDB)과 sqlite_session_db.py(SqliteSessionDB)는
항상 동일한 공개 인터페이스를 유지해야 한다.

메서드를 추가·삭제·시그니처 변경할 때는 반드시 두 파일을 동시에 수정한다.
한쪽만 바꾸면 로컬 모드(SQLite)와 프로덕션 모드(PostgreSQL)의 동작이 달라진다.

  이 파일 변경 → sqlite_session_db.py 도 반드시 확인
"""

import json
import logging
from datetime import datetime, timezone
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Optional, Union

import asyncpg

logger = logging.getLogger(__name__)

_SESSION_COLUMNS = frozenset({
    "folder_id", "display_name", "session_type", "status",
    "prompt", "client_id", "claude_session_id", "last_message",
    "metadata", "was_running_at_shutdown",
    "last_event_id", "last_read_event_id",
    "created_at", "updated_at", "node_id", "agent_id",
})

_FOLDER_COLUMNS = frozenset({"name", "sort_order", "settings"})

# 폴더 컬럼 중 JSONB 직렬화가 필요한 컬럼
_FOLDER_JSONB_COLUMNS = frozenset({"settings"})

# timestamptz 컬럼 — 문자열이면 datetime으로 자동 변환
_TIMESTAMP_COLUMNS = frozenset({"created_at", "updated_at"})

# JSONB 컬럼 목록 — Python dict ↔ PostgreSQL JSONB 자동 변환
_JSONB_COLUMNS = frozenset({"last_message", "metadata"})

# 최초 설정 이후 덮어쓸 수 없는 식별 필드
IMMUTABLE_FIELDS: frozenset[str] = frozenset({"claude_session_id", "node_id", "agent_id"})


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class PostgresSessionDB:
    """PostgreSQL 기반 세션 저장소

    Args:
        database_url: PostgreSQL 접속 URL
        node_id: 노드 식별자. None이면 전역 뷰 (오케스트레이터용)
        schema_path: DDL 파일 경로. None이면 스키마 배포 생략.
    """

    DEFAULT_FOLDERS = {"claude": "⚙️ 클로드 코드 세션", "llm": "⚙️ LLM 세션"}

    def __init__(
        self,
        database_url: str,
        node_id: Optional[str] = None,
        schema_path: Optional[Path] = None,
    ):
        self._database_url = database_url
        self._node_id = node_id
        self._schema_path = schema_path
        self._pool: Optional[asyncpg.Pool] = None

    @property
    def node_id(self) -> Optional[str]:
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
        if self._schema_path is not None:
            await self._apply_schema()
        logger.info("PostgreSQL connection pool established")

    async def _apply_schema(self) -> None:
        """DDL 정본 파일을 실행하여 스키마와 프로시저를 배포한다.

        실패 시 예외 → 서버 기동 중단.
        """
        if self._schema_path is None:
            return
        sql = self._schema_path.read_text(encoding="utf-8")
        await self._pool.execute(sql)
        logger.info("Schema and procedures deployed from %s", self._schema_path.name)

    async def close(self) -> None:
        if self._pool:
            await self._pool.close()

    # --- 세션 CRUD ---

    async def upsert_session(self, session_id: str, **fields) -> None:
        invalid = set(fields) - _SESSION_COLUMNS
        if invalid:
            raise ValueError(f"Invalid session columns: {invalid}")

        # 불변 필드 보호: None 포함 모든 덮어쓰기 시도 시 기존 값 확인 후 충돌 방지
        immutable_updates = {k: v for k, v in fields.items() if k in IMMUTABLE_FIELDS}
        if immutable_updates:
            row = await self._pool.fetchrow(
                "SELECT claude_session_id, node_id, agent_id FROM sessions WHERE session_id = $1",
                session_id,
            )
            if row:
                existing = dict(row)
                for field, new_val in immutable_updates.items():
                    old_val = existing.get(field)
                    if old_val is not None and old_val != new_val:
                        raise ValueError(
                            f"Immutable field '{field}' already set to {old_val!r}, "
                            f"cannot overwrite with {new_val!r}"
                        )

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
    ) -> None:
        """세션 최초 등록 (순수 INSERT).

        4개 불변 ID(session_id, node_id, agent_id, claude_session_id)를 원자적으로 기록한다.
        중복 호출 시 DB 고유 제약 위반 예외 발생 (ON CONFLICT 없음).
        """
        now = _utc_now()
        await self._pool.execute(
            "SELECT session_register($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
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

    _UPDATE_SESSION_IMMUTABLE = frozenset({
        "node_id", "agent_id", "claude_session_id", "session_type", "created_at",
    })

    async def update_session(self, session_id: str, **fields) -> None:
        """세션 속성 갱신 (순수 UPDATE).

        불변 필드(node_id, agent_id, claude_session_id, session_type, created_at)는
        허용하지 않는다 — ValueError를 발생시킨다.
        DB 프로시저(session_update)도 해당 필드를 거부한다.
        """
        invalid = set(fields) & self._UPDATE_SESSION_IMMUTABLE
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
            "SELECT * FROM session_get($1)", session_id
        )
        if row is None:
            return None
        return self._deserialize_session(row)

    async def get_all_sessions(
        self,
        offset: int = 0,
        limit: int = 0,
        session_type: Optional[str] = None,
        folder_id: Optional[str] = None,
        node_id: Optional[str] = None,
        status: Optional[Union[str, list[str]]] = None,
    ) -> tuple[list[dict], int]:
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
        return [self._deserialize_session(r) for r in rows], total

    async def get_folder_counts(
        self,
        node_id: Optional[str] = None,
    ) -> dict:
        """folder_id별 세션 수를 반환한다.

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
        return [self._deserialize_session(r) for r in rows]

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

    # --- 이벤트 CRUD ---

    async def append_event(
        self,
        session_id: str,
        event_type: str,
        payload: str,
        searchable_text: str,
        created_at: str,
    ) -> int:
        """이벤트를 원자적으로 저장하고 할당된 event_id를 반환한다."""
        # created_at이 ISO 문자열이면 timestamptz로 변환
        if isinstance(created_at, str):
            try:
                created_at = datetime.fromisoformat(created_at)
            except ValueError:
                created_at = _utc_now()

        event_id = await self._pool.fetchval(
            "SELECT event_append($1, $2, $3, $4, $5)",
            session_id, event_type, payload, searchable_text, created_at,
        )
        return event_id

    async def read_events(
        self, session_id: str, after_id: int = 0,
        limit: int | None = None, event_types: list[str] | None = None,
    ) -> list[dict]:
        rows = await self._pool.fetch(
            "SELECT * FROM event_read($1, $2, $3, $4)",
            session_id, after_id, limit, event_types,
        )
        return [self._event_to_dict(r) for r in rows]

    async def stream_events_raw(
        self, session_id: str, after_id: int = 0,
    ) -> AsyncGenerator[tuple[int, str, str], None]:
        """이벤트를 (id, event_type, payload_text) 튜플로 스트리밍."""
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                async for row in conn.cursor(
                    "SELECT * FROM event_stream_raw($1, $2)",
                    session_id, after_id,
                ):
                    yield row["id"], row["event_type"], row["payload_text"]

    async def read_one_event(self, session_id: str, event_id: int) -> Optional[dict]:
        row = await self._pool.fetchrow(
            "SELECT * FROM event_read_one($1, $2)",
            session_id, event_id,
        )
        return self._event_to_dict(row) if row else None

    async def count_events(self, session_id: str) -> int:
        return await self._pool.fetchval(
            "SELECT event_count($1)", session_id
        )

    @staticmethod
    def _event_to_dict(row: asyncpg.Record) -> dict:
        d = dict(row)
        if isinstance(d.get("created_at"), datetime):
            d["created_at"] = d["created_at"].isoformat()
        if isinstance(d.get("payload"), (dict, list)):
            d["payload"] = json.dumps(d["payload"], ensure_ascii=False)
        return d

    # --- 폴더 CRUD ---

    async def create_folder(self, folder_id: str, name: str, sort_order: int = 0) -> None:
        await self._pool.execute(
            "SELECT folder_create($1, $2, $3)",
            folder_id, name, sort_order,
        )

    async def update_folder(self, folder_id: str, **fields) -> None:
        if not fields:
            return
        invalid = set(fields) - _FOLDER_COLUMNS
        if invalid:
            raise ValueError(f"Invalid folder columns: {invalid}")

        columns = list(fields.keys())
        values = [
            json.dumps(v, ensure_ascii=False) if k in _FOLDER_JSONB_COLUMNS else str(v)
            for k, v in fields.items()
        ]

        await self._pool.execute(
            "SELECT folder_update($1, $2, $3)",
            folder_id, columns, values,
        )

    async def get_folder(self, folder_id: str) -> Optional[dict]:
        row = await self._pool.fetchrow(
            "SELECT * FROM folder_get($1)", folder_id
        )
        if row is None:
            return None
        d = dict(row)
        # asyncpg가 JSONB 코덱 미등록 시 settings를 문자열로 반환하는 경우 역직렬화
        if isinstance(d.get("settings"), str):
            try:
                d["settings"] = json.loads(d["settings"])
            except (json.JSONDecodeError, ValueError):
                d["settings"] = {}
        return d

    async def delete_folder(self, folder_id: str) -> None:
        await self._pool.execute(
            "SELECT folder_delete($1)", folder_id
        )

    async def get_all_folders(self) -> list[dict]:
        rows = await self._pool.fetch(
            "SELECT * FROM folder_get_all()"
        )
        result = []
        for r in rows:
            d = dict(r)
            # asyncpg는 TIMESTAMPTZ를 Python datetime 객체로 반환 — JSON 직렬화를 위해 변환
            if d.get("created_at") is not None:
                d["created_at"] = d["created_at"].isoformat()
            # asyncpg가 JSONB 컬럼을 문자열로 반환하는 경우 역직렬화
            # (JSON 코덱 미등록 시 JSONB → str로 반환됨)
            if isinstance(d.get("settings"), str):
                try:
                    d["settings"] = json.loads(d["settings"])
                except (json.JSONDecodeError, ValueError):
                    d["settings"] = {}
            result.append(d)
        return result

    async def get_default_folder(self, name: str) -> Optional[dict]:
        row = await self._pool.fetchrow(
            "SELECT * FROM folder_get_default($1)", name
        )
        return dict(row) if row else None

    async def ensure_default_folders(self) -> None:
        folders_json = json.dumps([
            {"id": fid, "name": fname, "sort_order": 0}
            for fid, fname in self.DEFAULT_FOLDERS.items()
        ])
        await self._pool.execute(
            "SELECT folder_ensure_defaults($1::jsonb)", folders_json,
        )

    async def ensure_indexes(self) -> None:
        """No-op. 인덱스는 schema.sql에서 DDL로 관리한다."""
        pass

    # --- 카탈로그 ---

    async def assign_session_to_folder(
        self, session_id: str, folder_id: Optional[str]
    ) -> None:
        await self._pool.execute(
            "SELECT session_assign_folder($1, $2)",
            session_id, folder_id,
        )

    async def rename_session(self, session_id: str, display_name: Optional[str]) -> None:
        await self._pool.execute(
            "SELECT session_rename($1, $2)",
            session_id, display_name,
        )

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

        rows = await self._pool.fetch(
            "SELECT * FROM catalog_get_sessions()"
        )
        sessions = {}
        for r in rows:
            sessions[r["session_id"]] = {
                "folderId": r["folder_id"],
                "displayName": r["display_name"],
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
        """경량 세션 목록과 total count를 반환한다."""
        rows = await self._pool.fetch(
            "SELECT * FROM session_list_summary($1, $2, $3, $4, $5, $6)",
            search, session_type, limit, offset, folder_id, node_id,
        )
        if not rows:
            return [], 0
        total = rows[0]["total_count"]
        sessions = [
            {k: v for k, v in dict(r).items() if k != "total_count"}
            for r in rows
        ]
        return sessions, total

    # --- 전문검색 (tsvector) ---

    async def search_events(
        self,
        query: str,
        session_ids: Optional[list[str]] = None,
        limit: int = 50,
    ) -> list[dict]:
        if not query.strip():
            return []

        try:
            rows = await self._pool.fetch(
                "SELECT * FROM event_search($1, $2, $3)",
                query, session_ids, limit,
            )
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
