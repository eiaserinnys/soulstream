"""
SqliteSessionDB - SQLite 기반 세션 저장소 (thin assembly class)

5개 도메인 mixin(session_crud, events, viewport, folders, search)을 합성하여
SessionDBBase 인터페이스를 구현한다.

인프라 관심사(connect/close/conn/migration)만 이 파일에 남긴다.
도메인 로직은 soul_common.db.sqlite.* 모듈에서 구현한다.

인터페이스 정본은 SessionDBBase(session_db_base.py)에 정의되어 있다.
메서드를 추가·삭제·시그니처 변경할 때는 SessionDBBase를 먼저 수정한다.
"""

import asyncio
import logging
from pathlib import Path
from typing import Optional, Union

import aiosqlite

from soul_common.db.session_db_base import SessionDBBase
from soul_common.db.sqlite.session_crud import SqliteSessionCRUDMixin
from soul_common.db.sqlite.events import SqliteEventMixin
from soul_common.db.sqlite.viewport import SqliteViewportMixin
from soul_common.db.sqlite.folders import SqliteFolderMixin
from soul_common.db.sqlite.search import SqliteSearchMixin

logger = logging.getLogger(__name__)


class SqliteSessionDB(
    SqliteSessionCRUDMixin,
    SqliteEventMixin,
    SqliteViewportMixin,
    SqliteFolderMixin,
    SqliteSearchMixin,
    SessionDBBase,
):
    """SQLite 기반 세션 저장소

    5개 도메인 mixin이 SessionDBBase의 모든 추상 메서드를 구현한다.
    이 클래스는 인프라(connect/close/conn/migration)만 담당한다.

    Args:
        db_path: SQLite 파일 경로
        node_id: 노드 식별자. None이면 전역 뷰
        schema_path: DDL 파일 경로. None이면 스키마 배포 생략
    """

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

        try:
            await self._conn.execute(
                "ALTER TABLE folders ADD COLUMN parent_folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL"
            )
            await self._conn.commit()
        except Exception:
            pass

        await self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS markdown_documents (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                body TEXT NOT NULL DEFAULT '',
                version INTEGER NOT NULL DEFAULT 1,
                created_at TEXT,
                updated_at TEXT
            )
            """
        )
        try:
            await self._conn.execute(
                "ALTER TABLE markdown_documents ADD COLUMN version INTEGER NOT NULL DEFAULT 1"
            )
            await self._conn.commit()
        except Exception:
            pass
        await self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS board_items (
                id TEXT PRIMARY KEY,
                folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
                container_kind TEXT NOT NULL DEFAULT 'folder' CHECK (container_kind IN ('folder', 'runbook')),
                container_id TEXT NOT NULL DEFAULT '',
                membership_kind TEXT NOT NULL DEFAULT 'primary' CHECK (membership_kind IN ('primary', 'reference')),
                source_runbook_item_id TEXT,
                item_type TEXT NOT NULL CHECK (item_type IN ('session', 'markdown', 'subfolder', 'asset', 'frame', 'runbook')),
                item_id TEXT NOT NULL,
                x REAL NOT NULL DEFAULT 0,
                y REAL NOT NULL DEFAULT 0,
                metadata TEXT NOT NULL DEFAULT '{}',
                created_at TEXT,
                updated_at TEXT,
                UNIQUE (folder_id, item_id)
            )
            """
        )
        for ddl in [
            "ALTER TABLE board_items ADD COLUMN container_kind TEXT NOT NULL DEFAULT 'folder'",
            "ALTER TABLE board_items ADD COLUMN container_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE board_items ADD COLUMN membership_kind TEXT NOT NULL DEFAULT 'primary'",
            "ALTER TABLE board_items ADD COLUMN source_runbook_item_id TEXT",
        ]:
            try:
                await self._conn.execute(ddl)
                await self._conn.commit()
            except Exception:
                pass
        await self._conn.execute(
            """
            UPDATE board_items
            SET container_kind = COALESCE(NULLIF(container_kind, ''), 'folder'),
                container_id = COALESCE(NULLIF(container_id, ''), folder_id),
                membership_kind = COALESCE(NULLIF(membership_kind, ''), 'primary')
            """
        )
        await self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_board_items_folder ON board_items (folder_id, y, x)"
        )
        await self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_board_items_container ON board_items (container_kind, container_id, y, x)"
        )
        await self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_board_items_ref ON board_items (item_type, item_id)"
        )
        await self._conn.commit()

        try:
            await self._conn.execute(
                "ALTER TABLE sessions ADD COLUMN caller_session_id TEXT"
            )
            await self._conn.commit()
        except Exception:
            pass

        try:
            await self._conn.execute(
                "ALTER TABLE sessions ADD COLUMN away_summary TEXT"
            )
            await self._conn.commit()
        except Exception:
            pass

    async def close(self) -> None:
        if self._conn:
            await self._conn.close()
            self._conn = None

    # extract_searchable_text는 SessionDBBase에서 상속 (하위 호환 staticmethod)
    # 독립 함수: soul_common.db.session_db_base.extract_searchable_text
