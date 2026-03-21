"""
SessionDB - SQLite 기반 세션 저장소

세션 메타데이터, 이벤트, 폴더 카탈로그를 단일 SQLite DB로 통합 관리한다.
기존 EventStore, SessionCatalog, TaskStorage를 대체한다.

WAL 모드 사용, FTS5 전문검색 지원.
"""

import json
import logging
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

SCHEMA_SQL = """\
-- 폴더 카탈로그
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- 세션 메타데이터
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  display_name TEXT,
  session_type TEXT NOT NULL DEFAULT 'claude',
  status TEXT NOT NULL DEFAULT 'running',
  prompt TEXT,
  client_id TEXT,
  claude_session_id TEXT,
  last_message TEXT,
  metadata TEXT,
  was_running_at_shutdown INTEGER NOT NULL DEFAULT 0,
  last_event_id INTEGER NOT NULL DEFAULT 0,
  last_read_event_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_folder ON sessions(folder_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_type ON sessions(session_type);

-- 이벤트
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  event_type TEXT,
  payload TEXT NOT NULL,
  searchable_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);

-- FTS5 전문검색
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  searchable_text,
  content=events,
  content_rowid=id,
  tokenize='unicode61'
);

-- FTS5 자동 동기화 트리거
CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, searchable_text)
  VALUES (new.id, new.searchable_text);
END;

CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, searchable_text)
  VALUES ('delete', old.id, old.searchable_text);
END;

CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, searchable_text)
  VALUES ('delete', old.id, old.searchable_text);
  INSERT INTO events_fts(rowid, searchable_text)
  VALUES (new.id, new.searchable_text);
END;
"""


_SESSION_COLUMNS = frozenset({
    "folder_id", "display_name", "session_type", "status",
    "prompt", "client_id", "claude_session_id", "last_message",
    "metadata", "was_running_at_shutdown",
    "last_event_id", "last_read_event_id",
    "created_at", "updated_at",
})

_FOLDER_COLUMNS = frozenset({"name", "sort_order"})


def _utc_now_str() -> str:
    return datetime.now(timezone.utc).isoformat()


class SessionDB:
    """SQLite 기반 세션 저장소"""

    # shared/constants.ts의 SYSTEM_FOLDERS와 동기화 필수
    DEFAULT_FOLDERS = {"claude": "⚙️ 클로드 코드 세션", "llm": "⚙️ LLM 세션"}

    def __init__(self, db_path: Path):
        self._db_path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(db_path))
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(SCHEMA_SQL)

        # 인라인 마이그레이션: last_event_id, last_read_event_id 컬럼 추가
        for col, col_type, default in [
            ("last_event_id", "INTEGER", 0),
            ("last_read_event_id", "INTEGER", 0),
        ]:
            try:
                self._conn.execute(
                    f"ALTER TABLE sessions ADD COLUMN {col} {col_type} NOT NULL DEFAULT {default}"
                )
            except sqlite3.OperationalError:
                pass  # 이미 존재

        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    # --- 세션 CRUD ---

    def upsert_session(self, session_id: str, **fields) -> None:
        invalid = set(fields) - _SESSION_COLUMNS
        if invalid:
            raise ValueError(f"Invalid session columns: {invalid}")

        existing = self.get_session(session_id)
        now = _utc_now_str()
        if existing is None:
            cols = {
                "session_id": session_id,
                "created_at": fields.pop("created_at", now),
                "updated_at": fields.pop("updated_at", now),
            }
            cols.update(fields)
            placeholders = ", ".join(f":{k}" for k in cols)
            col_names = ", ".join(cols.keys())
            self._conn.execute(
                f"INSERT INTO sessions ({col_names}) VALUES ({placeholders})",
                cols,
            )
        else:
            fields["updated_at"] = fields.get("updated_at", now)
            set_clause = ", ".join(f"{k} = :{k}" for k in fields)
            fields["session_id"] = session_id
            self._conn.execute(
                f"UPDATE sessions SET {set_clause} WHERE session_id = :session_id",
                fields,
            )
        self._conn.commit()

    @staticmethod
    def _deserialize_session(row: sqlite3.Row) -> dict:
        d = dict(row)
        for field in ("last_message", "metadata"):
            if d.get(field):
                try:
                    d[field] = json.loads(d[field])
                except (json.JSONDecodeError, TypeError):
                    pass
        return d

    def get_session(self, session_id: str) -> Optional[dict]:
        row = self._conn.execute(
            "SELECT * FROM sessions WHERE session_id = ?", (session_id,)
        ).fetchone()
        if row is None:
            return None
        return self._deserialize_session(row)

    def get_all_sessions(
        self, offset: int = 0, limit: int = 0, session_type: Optional[str] = None
    ) -> tuple[list[dict], int]:
        where = ""
        params: dict = {}
        if session_type:
            where = "WHERE session_type = :session_type"
            params["session_type"] = session_type

        total = self._conn.execute(
            f"SELECT COUNT(*) FROM sessions {where}", params
        ).fetchone()[0]

        sql = f"SELECT * FROM sessions {where} ORDER BY updated_at DESC"
        if limit > 0:
            sql += " LIMIT :limit OFFSET :offset"
            params["limit"] = limit
            params["offset"] = offset
        elif offset > 0:
            sql += " LIMIT -1 OFFSET :offset"
            params["offset"] = offset

        rows = self._conn.execute(sql, params).fetchall()
        return [self._deserialize_session(r) for r in rows], total

    def delete_session(self, session_id: str) -> None:
        self._conn.execute(
            "DELETE FROM sessions WHERE session_id = ?", (session_id,)
        )
        self._conn.commit()

    def append_metadata(self, session_id: str, entry: dict) -> None:
        """세션에 메타데이터 엔트리를 추가한다.

        기존 metadata JSON 배열에 엔트리를 추가하고,
        events 테이블에 synthetic metadata 이벤트를 삽입하여
        FTS5 자동 인덱싱을 트리거한다.

        Args:
            session_id: 세션 ID
            entry: 메타데이터 엔트리 dict
                {type, value, label?, url?, timestamp, tool_name}

        Raises:
            ValueError: 세션이 존재하지 않을 때
        """
        session = self.get_session(session_id)
        if session is None:
            raise ValueError(f"Session not found: {session_id}")

        # 기존 metadata에 추가
        existing = session.get("metadata") or []
        existing.append(entry)
        metadata_json = json.dumps(existing, ensure_ascii=False)

        now = _utc_now_str()
        self._conn.execute(
            "UPDATE sessions SET metadata = ?, updated_at = ? WHERE session_id = ?",
            (metadata_json, now, session_id),
        )

        # synthetic metadata 이벤트 삽입 (FTS5 인덱싱)
        searchable = f"{entry.get('type', '')}: {entry.get('value', '')} {entry.get('label', '')}"
        event_payload = json.dumps({
            "type": "metadata",
            "metadata_type": entry.get("type"),
            "value": entry.get("value"),
            "label": entry.get("label"),
        }, ensure_ascii=False)

        next_id = self.get_next_event_id(session_id)
        self._conn.execute(
            "INSERT INTO events (id, session_id, event_type, payload, searchable_text, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (next_id, session_id, "metadata", event_payload, searchable, now),
        )

        self._conn.commit()

    def update_last_message(self, session_id: str, last_message: dict) -> None:
        now = _utc_now_str()
        self._conn.execute(
            "UPDATE sessions SET last_message = ?, updated_at = ? WHERE session_id = ?",
            (json.dumps(last_message, ensure_ascii=False), now, session_id),
        )
        self._conn.commit()

    # --- 읽음 상태 관리 ---

    def update_last_read_event_id(self, session_id: str, event_id: int) -> bool:
        """읽음 위치 갱신. 성공 시 True, 세션 미존재 시 False."""
        cursor = self._conn.execute(
            "UPDATE sessions SET last_read_event_id = ? WHERE session_id = ?",
            (event_id, session_id),
        )
        self._conn.commit()
        return cursor.rowcount > 0

    def get_read_position(self, session_id: str) -> tuple[int, int]:
        """(last_event_id, last_read_event_id) 반환."""
        row = self._conn.execute(
            "SELECT last_event_id, last_read_event_id FROM sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if row is None:
            raise ValueError(f"Session not found: {session_id}")
        return (row[0], row[1])

    def mark_running_at_shutdown(self) -> None:
        self._conn.execute(
            "UPDATE sessions SET was_running_at_shutdown = 1 WHERE status = 'running'"
        )
        self._conn.commit()

    def get_shutdown_sessions(self) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM sessions WHERE was_running_at_shutdown = 1"
        ).fetchall()
        return [dict(r) for r in rows]

    def clear_shutdown_flags(self) -> None:
        self._conn.execute(
            "UPDATE sessions SET was_running_at_shutdown = 0 WHERE was_running_at_shutdown = 1"
        )
        self._conn.commit()

    # --- 이벤트 CRUD ---

    def append_event(
        self,
        session_id: str,
        event_id: int,
        event_type: str,
        payload: str,
        searchable_text: str,
        created_at: str,
    ) -> None:
        self._conn.execute(
            "INSERT INTO events (id, session_id, event_type, payload, searchable_text, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (event_id, session_id, event_type, payload, searchable_text, created_at),
        )
        # 세션의 last_event_id를 자동 갱신
        self._conn.execute(
            "UPDATE sessions SET last_event_id = ? WHERE session_id = ?",
            (event_id, session_id),
        )
        self._conn.commit()

    def read_events(self, session_id: str, after_id: int = 0) -> list[dict]:
        rows = self._conn.execute(
            "SELECT id, session_id, event_type, payload, searchable_text, created_at "
            "FROM events WHERE session_id = ? AND id > ? ORDER BY id",
            (session_id, after_id),
        ).fetchall()
        return [dict(r) for r in rows]

    def read_one_event(self, session_id: str, event_id: int) -> Optional[dict]:
        row = self._conn.execute(
            "SELECT id, session_id, event_type, payload, searchable_text, created_at "
            "FROM events WHERE session_id = ? AND id = ?",
            (session_id, event_id),
        ).fetchone()
        return dict(row) if row else None

    def get_next_event_id(self, session_id: str) -> int:
        row = self._conn.execute(
            "SELECT MAX(id) FROM events"
        ).fetchone()
        max_id = row[0] if row[0] is not None else 0
        return max_id + 1

    def count_events(self, session_id: str) -> int:
        row = self._conn.execute(
            "SELECT COUNT(*) FROM events WHERE session_id = ?", (session_id,)
        ).fetchone()
        return row[0]

    # --- 폴더 CRUD ---

    def create_folder(self, folder_id: str, name: str, sort_order: int = 0) -> None:
        self._conn.execute(
            "INSERT INTO folders (id, name, sort_order) VALUES (?, ?, ?)",
            (folder_id, name, sort_order),
        )
        self._conn.commit()

    def update_folder(self, folder_id: str, **fields) -> None:
        if not fields:
            return
        invalid = set(fields) - _FOLDER_COLUMNS
        if invalid:
            raise ValueError(f"Invalid folder columns: {invalid}")
        set_clause = ", ".join(f"{k} = :{k}" for k in fields)
        fields["folder_id"] = folder_id
        self._conn.execute(
            f"UPDATE folders SET {set_clause} WHERE id = :folder_id", fields
        )
        self._conn.commit()

    def get_folder(self, folder_id: str) -> Optional[dict]:
        row = self._conn.execute(
            "SELECT * FROM folders WHERE id = ?", (folder_id,)
        ).fetchone()
        return dict(row) if row else None

    def delete_folder(self, folder_id: str) -> None:
        self._conn.execute("DELETE FROM folders WHERE id = ?", (folder_id,))
        self._conn.commit()

    def get_all_folders(self) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM folders ORDER BY sort_order, name"
        ).fetchall()
        return [dict(r) for r in rows]

    def get_default_folder(self, name: str) -> Optional[dict]:
        row = self._conn.execute(
            "SELECT * FROM folders WHERE name = ?", (name,)
        ).fetchone()
        return dict(row) if row else None

    def ensure_default_folders(self) -> None:
        # 마이그레이션: 기존 폴더명 → 새 폴더명 (⚙️ 접두사 추가)
        _OLD_TO_NEW = {
            '클로드 코드 세션': '⚙️ 클로드 코드 세션',
            'LLM 세션': '⚙️ LLM 세션',
        }
        for old_name, new_name in _OLD_TO_NEW.items():
            self._conn.execute('UPDATE folders SET name = ? WHERE name = ?', (new_name, old_name))
        self._conn.commit()

        for key, name in self.DEFAULT_FOLDERS.items():
            existing = self.get_default_folder(name)
            if existing is None:
                self.create_folder(str(uuid.uuid4()), name, sort_order=0)

    # --- 카탈로그 (세션-폴더 매핑 + 이름) ---

    def assign_session_to_folder(
        self, session_id: str, folder_id: Optional[str]
    ) -> None:
        self._conn.execute(
            "UPDATE sessions SET folder_id = ? WHERE session_id = ?",
            (folder_id, session_id),
        )
        self._conn.commit()

    def rename_session(self, session_id: str, display_name: Optional[str]) -> None:
        self._conn.execute(
            "UPDATE sessions SET display_name = ? WHERE session_id = ?",
            (display_name, session_id),
        )
        self._conn.commit()

    def get_catalog(self) -> dict:
        folders = self.get_all_folders()
        folder_list = [
            {"id": f["id"], "name": f["name"], "sortOrder": f["sort_order"]}
            for f in folders
        ]

        rows = self._conn.execute(
            "SELECT session_id, folder_id, display_name FROM sessions"
        ).fetchall()
        sessions = {}
        for r in rows:
            sessions[r["session_id"]] = {
                "folderId": r["folder_id"],
                "displayName": r["display_name"],
            }

        return {"folders": folder_list, "sessions": sessions}

    # --- FTS5 검색 ---

    def search_events(
        self,
        query: str,
        session_ids: Optional[list[str]] = None,
        limit: int = 50,
    ) -> list[dict]:
        if not query.strip():
            return []

        # FTS5 쿼리: 각 토큰에 * 접미사를 붙여 prefix 매칭
        # 큰따옴표를 제거하여 FTS5 구문 오류 방지
        tokens = query.strip().split()
        fts_query = " ".join(
            f'"{t.replace(chr(34), "")}"*'
            for t in tokens
            if t.replace('"', '')
        )
        if not fts_query:
            return []

        if session_ids:
            placeholders = ", ".join("?" for _ in session_ids)
            sql = (
                "SELECT e.id, e.session_id, e.event_type, e.payload, "
                "e.searchable_text, e.created_at "
                "FROM events e "
                "JOIN events_fts ON events_fts.rowid = e.id "
                f"WHERE events_fts MATCH ? AND e.session_id IN ({placeholders}) "
                "ORDER BY rank LIMIT ?"
            )
            params = [fts_query, *session_ids, limit]
        else:
            sql = (
                "SELECT e.id, e.session_id, e.event_type, e.payload, "
                "e.searchable_text, e.created_at "
                "FROM events e "
                "JOIN events_fts ON events_fts.rowid = e.id "
                "WHERE events_fts MATCH ? "
                "ORDER BY rank LIMIT ?"
            )
            params = [fts_query, limit]

        try:
            rows = self._conn.execute(sql, params).fetchall()
            return [dict(r) for r in rows]
        except sqlite3.OperationalError as e:
            logger.warning(f"FTS5 search failed: {e}")
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
            # "result" (현재 형식) 또는 "content" (레거시) 키 지원
            content = event.get("result") or event.get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                texts = [c.get("text", "") for c in content if isinstance(c, dict)]
                return " ".join(filter(None, texts))
        elif event_type in ("user", "user_message"):
            # "text" (현재) 또는 "content" (레거시) 키 지원
            text = event.get("text") or event.get("content")
            if isinstance(text, str):
                return text
            if isinstance(text, list):
                texts = [c.get("text", "") for c in text if isinstance(c, dict)]
                return " ".join(filter(None, texts))
        return ""

    # --- 마이그레이션 ---

    @staticmethod
    def migrate_from_legacy(db_path: Path, data_dir: Path) -> bool:
        """레거시 JSONL/JSON 파일을 SQLite로 마이그레이션한다.

        SessionDB 인스턴스 생성 전에 호출한다.
        성공 시 원본 파일을 삭제한다.
        실패 시 롤백하고 원본을 유지한다.

        Returns:
            True: 마이그레이션 수행됨, False: 마이그레이션 불필요
        """
        catalog_path = data_dir / "session_catalog.json"
        events_dir = data_dir / "events"
        tasks_path = data_dir / "tasks.json"
        pre_shutdown_path = data_dir / "pre_shutdown_sessions.json"

        if not catalog_path.exists() and not events_dir.exists():
            return False

        logger.info("Starting legacy migration to SQLite...")

        # 레거시 데이터 로드
        catalog_entries: dict = {}
        if catalog_path.exists():
            try:
                raw = catalog_path.read_text(encoding="utf-8")
                data = json.loads(raw)
                catalog_entries = data.get("entries", {})
            except Exception as e:
                logger.error(f"Failed to read session_catalog.json: {e}")
                return False

        # JSONL 파일 목록
        jsonl_files: dict[str, Path] = {}
        if events_dir.exists():
            for f in events_dir.glob("*.jsonl"):
                jsonl_files[f.stem] = f

        # tasks.json 로드
        tasks_data: dict = {}
        if tasks_path.exists():
            try:
                raw = tasks_path.read_text(encoding="utf-8")
                tasks_data = json.loads(raw)
            except Exception as e:
                logger.warning(f"Failed to read tasks.json: {e}")

        # pre_shutdown_sessions.json 로드
        pre_shutdown_ids: list[str] = []
        if pre_shutdown_path.exists():
            try:
                raw = pre_shutdown_path.read_text(encoding="utf-8")
                pre_shutdown_ids = json.loads(raw)
            except Exception as e:
                logger.warning(f"Failed to read pre_shutdown_sessions.json: {e}")

        # 마이그레이션 대상 세션 ID 합집합
        all_session_ids = set(catalog_entries.keys()) | set(jsonl_files.keys())
        if not all_session_ids:
            logger.info("No sessions to migrate")
            return False

        db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.executescript(SCHEMA_SQL)

            # 기본 폴더 생성
            claude_folder_id = str(uuid.uuid4())
            llm_folder_id = str(uuid.uuid4())
            conn.execute(
                "INSERT OR IGNORE INTO folders (id, name, sort_order) VALUES (?, ?, ?)",
                (claude_folder_id, SessionDB.DEFAULT_FOLDERS["claude"], 0),
            )
            conn.execute(
                "INSERT OR IGNORE INTO folders (id, name, sort_order) VALUES (?, ?, ?)",
                (llm_folder_id, SessionDB.DEFAULT_FOLDERS["llm"], 1),
            )

            for sid in all_session_ids:
                catalog_entry = catalog_entries.get(sid, {})
                has_catalog = sid in catalog_entries
                has_jsonl = sid in jsonl_files

                # 세션 타입 결정
                session_type = catalog_entry.get("session_type")
                if not session_type:
                    session_type = "llm" if sid.startswith("llm-") else "claude"

                # 상태 결정: 고아 JSONL은 INTERRUPTED
                status = catalog_entry.get("status", "interrupted" if not has_catalog else "running")

                # 폴더 자동 배치
                folder_id = llm_folder_id if session_type == "llm" else claude_folder_id

                # last_message JSON 직렬화
                last_message = catalog_entry.get("last_message")
                last_message_str = (
                    json.dumps(last_message, ensure_ascii=False)
                    if last_message
                    else None
                )

                created_at = catalog_entry.get("created_at", _utc_now_str())
                updated_at = catalog_entry.get("updated_at") or catalog_entry.get("completed_at") or created_at

                conn.execute(
                    "INSERT OR IGNORE INTO sessions "
                    "(session_id, folder_id, display_name, session_type, status, "
                    "prompt, client_id, claude_session_id, last_message, metadata, "
                    "was_running_at_shutdown, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        sid,
                        folder_id,
                        None,  # display_name: 레거시에 없음
                        session_type,
                        status,
                        catalog_entry.get("prompt"),
                        catalog_entry.get("client_id"),
                        catalog_entry.get("claude_session_id"),
                        last_message_str,
                        None,  # metadata: 레거시에 없음
                        0,
                        created_at,
                        updated_at,
                    ),
                )

                # 이벤트 마이그레이션
                if has_jsonl:
                    jsonl_path = jsonl_files[sid]
                    try:
                        with open(jsonl_path, "r", encoding="utf-8") as f:
                            for line in f:
                                line = line.strip()
                                if not line:
                                    continue
                                try:
                                    record = json.loads(line)
                                    event_id = record.get("id", 0)
                                    event = record.get("event", {})
                                    event_type = event.get("type", "")
                                    payload = json.dumps(event, ensure_ascii=False)
                                    searchable = SessionDB.extract_searchable_text(event)
                                    created = event.get("timestamp", _utc_now_str())

                                    conn.execute(
                                        "INSERT OR IGNORE INTO events "
                                        "(id, session_id, event_type, payload, searchable_text, created_at) "
                                        "VALUES (?, ?, ?, ?, ?, ?)",
                                        (event_id, sid, event_type, payload, searchable, created),
                                    )
                                except json.JSONDecodeError:
                                    logger.warning(f"Skipping corrupted line in {jsonl_path}")
                    except OSError as e:
                        logger.warning(f"Failed to read {jsonl_path}: {e}")

            # pre_shutdown 플래그 설정
            for sid in pre_shutdown_ids:
                conn.execute(
                    "UPDATE sessions SET was_running_at_shutdown = 1 WHERE session_id = ?",
                    (sid,),
                )

            # tasks.json의 running 세션도 was_running_at_shutdown 설정
            running_tasks = tasks_data.get("tasks", {}) if isinstance(tasks_data, dict) else {}
            for sid, task_info in running_tasks.items():
                if isinstance(task_info, dict) and task_info.get("status") == "running":
                    conn.execute(
                        "UPDATE sessions SET was_running_at_shutdown = 1 WHERE session_id = ?",
                        (sid,),
                    )

            conn.commit()
            logger.info(f"Migration complete: {len(all_session_ids)} sessions")

            # 원본 파일 삭제
            _remove_legacy_files(catalog_path, events_dir, tasks_path, pre_shutdown_path)

        except Exception as e:
            conn.rollback()
            logger.error(f"Migration failed, rolled back: {e}")
            _cleanup_failed_db = True
            return False
        else:
            _cleanup_failed_db = False
            return True
        finally:
            try:
                conn.close()
            except Exception:
                pass
            if _cleanup_failed_db:
                for p in (
                    db_path,
                    db_path.with_suffix(".db-wal"),
                    db_path.with_suffix(".db-shm"),
                ):
                    try:
                        if p.exists():
                            p.unlink()
                    except OSError:
                        pass


def _remove_legacy_files(
    catalog_path: Path, events_dir: Path, tasks_path: Path, pre_shutdown_path: Path
) -> None:
    """마이그레이션 성공 후 레거시 파일 삭제"""
    try:
        if catalog_path.exists():
            catalog_path.unlink()
    except OSError as e:
        logger.warning(f"Failed to remove {catalog_path}: {e}")

    try:
        if events_dir.exists():
            import shutil
            shutil.rmtree(events_dir)
    except OSError as e:
        logger.warning(f"Failed to remove {events_dir}: {e}")

    try:
        if tasks_path.exists():
            tasks_path.unlink()
    except OSError as e:
        logger.warning(f"Failed to remove {tasks_path}: {e}")

    try:
        if pre_shutdown_path.exists():
            pre_shutdown_path.unlink()
    except OSError as e:
        logger.warning(f"Failed to remove {pre_shutdown_path}: {e}")


# === 싱글턴 인스턴스 관리 ===

_session_db: Optional[SessionDB] = None


def init_session_db(db: SessionDB) -> None:
    """SessionDB 전역 인스턴스 설정"""
    global _session_db
    _session_db = db


def get_session_db() -> SessionDB:
    """SessionDB 전역 인스턴스 반환"""
    if _session_db is None:
        raise RuntimeError("SessionDB not initialized.")
    return _session_db
