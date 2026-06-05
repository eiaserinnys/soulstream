"""PostgresFolderMixin — 폴더 CRUD + 카탈로그 (PostgreSQL)"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    import asyncpg

from soul_common.db.session_db_base import (
    FOLDER_COLUMNS as _FOLDER_COLUMNS,
    FOLDER_JSONB_COLUMNS as _FOLDER_JSONB_COLUMNS,
    DEFAULT_FOLDERS,
)

logger = logging.getLogger(__name__)


def _board_metadata(value: object) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (json.JSONDecodeError, ValueError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _normalize_board_item(row: dict) -> dict:
    created_at = row.get("created_at")
    updated_at = row.get("updated_at")
    if hasattr(created_at, "isoformat"):
        created_at = created_at.isoformat()
    if hasattr(updated_at, "isoformat"):
        updated_at = updated_at.isoformat()
    return {
        "id": row["id"],
        "folderId": row["folder_id"],
        "itemType": row["item_type"],
        "itemId": row["item_id"],
        "x": float(row["x"]),
        "y": float(row["y"]),
        "metadata": _board_metadata(row.get("metadata")),
        "createdAt": created_at,
        "updatedAt": updated_at,
    }


def _decode_jsonb_list(value: object) -> list:
    if value is None:
        return []
    if isinstance(value, str):
        parsed = json.loads(value)
        return parsed if isinstance(parsed, list) else []
    return value if isinstance(value, list) else []


def _normalize_markdown_document(row: dict) -> dict:
    created_at = row.get("created_at")
    updated_at = row.get("updated_at")
    if hasattr(created_at, "isoformat"):
        created_at = created_at.isoformat()
    if hasattr(updated_at, "isoformat"):
        updated_at = updated_at.isoformat()
    return {
        "id": row["id"],
        "title": row["title"],
        "body": row["body"],
        "createdAt": created_at,
        "updatedAt": updated_at,
    }


class PostgresFolderMixin:
    """폴더 CRUD + 카탈로그 (PostgreSQL 구현)

    Mixin이므로 self._pool은 PostgresSessionDB.__init__에서 설정된다.
    """

    _pool: asyncpg.Pool

    async def create_folder(
        self,
        folder_id: str,
        name: str,
        sort_order: int = 0,
        parent_folder_id: Optional[str] = None,
    ) -> None:
        await self._validate_parent_folder(folder_id, parent_folder_id)
        await self._pool.execute(
            "SELECT folder_create($1, $2, $3, $4)",
            folder_id, name, sort_order, parent_folder_id,
        )

    async def update_folder(self, folder_id: str, **fields) -> None:
        if not fields:
            return
        invalid = set(fields) - _FOLDER_COLUMNS
        if invalid:
            raise ValueError(f"Invalid folder columns: {invalid}")
        if "parent_folder_id" in fields:
            await self._validate_parent_folder(folder_id, fields["parent_folder_id"])

        columns = list(fields.keys())
        values = [
            json.dumps(v, ensure_ascii=False) if k in _FOLDER_JSONB_COLUMNS else (None if v is None else str(v))
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
            for fid, fname in DEFAULT_FOLDERS.items()
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
        folder_list = []
        for f in folders:
            created_at = f.get("created_at")
            if hasattr(created_at, "isoformat"):
                created_at = created_at.isoformat()
            folder_list.append({
                "id": f["id"],
                "name": f["name"],
                "sortOrder": f["sort_order"],
                "parentFolderId": f.get("parent_folder_id"),
                "settings": f.get("settings") or {},
                "createdAt": created_at,
            })

        rows = await self._pool.fetch(
            "SELECT * FROM catalog_get_sessions()"
        )
        sessions = {}
        for r in rows:
            sessions[r["session_id"]] = {
                "folderId": r["folder_id"],
                "displayName": r["display_name"],
            }

        board_items = await self.get_board_yjs_catalog_items()

        return {"folders": folder_list, "sessions": sessions, "boardItems": board_items}

    async def get_session_assignments(self) -> dict:
        rows = await self._pool.fetch(
            "SELECT * FROM catalog_get_sessions()"
        )
        return {
            r["session_id"]: {
                "folderId": r["folder_id"],
                "displayName": r["display_name"],
            }
            for r in rows
        }

    async def ensure_board_items(self) -> None:
        await self._pool.execute("SELECT board_seed_items()")

    async def get_board_items(self) -> list[dict]:
        # Legacy seed/read-replica access. get_catalog uses board_yjs_catalog_cache.
        rows = await self._pool.fetch("SELECT * FROM board_item_get_all()")
        return [_normalize_board_item(dict(r)) for r in rows]

    async def get_board_yjs_catalog_items(self, folder_id: Optional[str] = None) -> list[dict]:
        if folder_id is None:
            rows = await self._pool.fetch(
                """
                SELECT board_items
                FROM board_yjs_catalog_cache
                ORDER BY folder_id
                """
            )
        else:
            rows = await self._pool.fetch(
                """
                SELECT board_items
                FROM board_yjs_catalog_cache
                WHERE folder_id = $1
                ORDER BY folder_id
                """,
                folder_id,
            )
        items: list[dict] = []
        for row in rows:
            items.extend(dict(item) for item in _decode_jsonb_list(row["board_items"]))
        return items

    async def update_board_item_position(self, board_item_id: str, x: float, y: float) -> None:
        await self._pool.execute(
            """
            UPDATE board_items
            SET x = $2, y = $3, updated_at = NOW()
            WHERE id = $1
            """,
            board_item_id, x, y,
        )

    async def create_markdown_document(
        self,
        document_id: str,
        folder_id: str,
        title: str,
        body: str,
        x: float,
        y: float,
    ) -> dict:
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                doc_row = await conn.fetchrow(
                    """
                    INSERT INTO markdown_documents (id, title, body)
                    VALUES ($1, $2, $3)
                    RETURNING *
                    """,
                    document_id, title, body,
                )
                item_row = await conn.fetchrow(
                    """
                    INSERT INTO board_items (id, folder_id, item_type, item_id, x, y, metadata)
                    VALUES ($1, $2, 'markdown', $3, $4, $5, '{}'::jsonb)
                    RETURNING *
                    """,
                    f"markdown:{document_id}", folder_id, document_id, x, y,
                )
        assert doc_row is not None
        assert item_row is not None
        board_item = _normalize_board_item(dict(item_row))
        board_item["metadata"] = {
            "title": title,
            "preview": " ".join(body.split())[:180],
        }
        return {
            "document": _normalize_markdown_document(dict(doc_row)),
            "boardItem": board_item,
        }

    async def get_markdown_document(self, document_id: str) -> Optional[dict]:
        row = await self._pool.fetchrow(
            "SELECT * FROM markdown_documents WHERE id = $1",
            document_id,
        )
        return _normalize_markdown_document(dict(row)) if row else None

    async def update_markdown_document(
        self,
        document_id: str,
        title: Optional[str] = None,
        body: Optional[str] = None,
    ) -> Optional[dict]:
        fields = []
        values: list[object] = []
        if title is not None:
            values.append(title)
            fields.append(f"title = ${len(values) + 1}")
        if body is not None:
            values.append(body)
            fields.append(f"body = ${len(values) + 1}")
        if fields:
            values.insert(0, document_id)
            await self._pool.execute(
                f"""
                UPDATE markdown_documents
                SET {", ".join(fields)}, updated_at = NOW()
                WHERE id = $1
                """,
                *values,
            )
        return await self.get_markdown_document(document_id)

    async def delete_markdown_document(self, document_id: str) -> None:
        await self._pool.execute(
            "DELETE FROM markdown_documents WHERE id = $1",
            document_id,
        )

    async def _validate_parent_folder(
        self,
        folder_id: str,
        parent_folder_id: Optional[str],
    ) -> None:
        if parent_folder_id is None:
            return
        if folder_id == parent_folder_id:
            raise ValueError("folder parent cycle")

        rows = await self._pool.fetch(
            "SELECT id, parent_folder_id FROM folders"
        )
        parent_by_id = {r["id"]: r["parent_folder_id"] for r in rows}
        current = parent_folder_id
        seen: set[str] = set()
        while current is not None:
            if current == folder_id:
                raise ValueError("folder parent cycle")
            if current in seen:
                raise ValueError("folder parent cycle")
            seen.add(current)
            current = parent_by_id.get(current)
