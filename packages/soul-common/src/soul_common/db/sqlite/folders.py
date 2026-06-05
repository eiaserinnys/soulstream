"""SqliteFolderMixin — 폴더 CRUD + 카탈로그 (SQLite)"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    import aiosqlite

from soul_common.db.session_db_base import (
    FOLDER_COLUMNS as _FOLDER_COLUMNS,
    FOLDER_JSONB_COLUMNS as _FOLDER_JSONB_COLUMNS,
    DEFAULT_FOLDERS,
)
from soul_common.db.sqlite._helpers import _utc_now

logger = logging.getLogger(__name__)


def _metadata_dict(value: object) -> dict:
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
    return {
        "id": row["id"],
        "folderId": row["folder_id"],
        "itemType": row["item_type"],
        "itemId": row["item_id"],
        "x": float(row["x"]),
        "y": float(row["y"]),
        "metadata": _metadata_dict(row.get("metadata")),
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
    }


def _normalize_markdown_document(row: dict) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "body": row["body"],
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
    }


def _normalize_file_asset(row: dict) -> dict:
    return {
        "id": row["id"],
        "storageKey": row["storage_key"],
        "originalName": row["original_name"],
        "mimeType": row["mime_type"],
        "byteSize": int(row["byte_size"]),
        "width": row.get("width"),
        "height": row.get("height"),
        "durationSeconds": row.get("duration_seconds"),
        "checksumSha256": row.get("checksum_sha256"),
        "uploadStatus": row.get("upload_status"),
        "multipartUploadId": row.get("multipart_upload_id"),
        "garbageCollectedAt": row.get("garbage_collected_at"),
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
    }


class SqliteFolderMixin:
    """폴더 CRUD + 카탈로그 (SQLite 구현)

    Mixin이므로 self._conn은 SqliteSessionDB.__init__에서 설정된다.
    """

    _conn: aiosqlite.Connection

    async def create_folder(
        self,
        folder_id: str,
        name: str,
        sort_order: int = 0,
        parent_folder_id: Optional[str] = None,
    ) -> None:
        await self._validate_parent_folder(folder_id, parent_folder_id)
        await self._conn.execute(
            "INSERT OR IGNORE INTO folders (id, name, sort_order, parent_folder_id) VALUES (?, ?, ?, ?)",
            (folder_id, name, sort_order, parent_folder_id),
        )
        await self._conn.commit()

    async def update_folder(self, folder_id: str, **fields) -> None:
        if not fields:
            return
        invalid = set(fields) - _FOLDER_COLUMNS
        if invalid:
            raise ValueError(f"Invalid folder columns: {invalid}")
        if "parent_folder_id" in fields:
            await self._validate_parent_folder(folder_id, fields["parent_folder_id"])
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
        if row is None:
            return None
        d = dict(row)
        # SQLite는 settings를 TEXT로 저장하므로 항상 문자열 역직렬화 필요
        if "settings" in d and isinstance(d["settings"], str):
            try:
                d["settings"] = json.loads(d["settings"])
            except (json.JSONDecodeError, ValueError):
                d["settings"] = {}
        return d

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
        for fid, fname in DEFAULT_FOLDERS.items():
            if fname == name:
                return await self.get_folder(fid)
        return None

    async def ensure_default_folders(self) -> None:
        for fid, fname in DEFAULT_FOLDERS.items():
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
        await self.ensure_board_items()
        folders = await self.get_all_folders()
        folder_list = [
            {
                "id": f["id"],
                "name": f["name"],
                "sortOrder": f["sort_order"],
                "parentFolderId": f.get("parent_folder_id"),
                "settings": f.get("settings") or {},
                "createdAt": f.get("created_at"),
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
        board_items = await self.get_board_items()
        return {"folders": folder_list, "sessions": sessions, "boardItems": board_items}

    async def get_session_assignments(self) -> dict:
        cursor = await self._conn.execute(
            "SELECT session_id, folder_id, display_name FROM sessions"
        )
        rows = await cursor.fetchall()
        return {
            row["session_id"]: {
                "folderId": row["folder_id"],
                "displayName": row["display_name"],
            }
            for row in rows
        }

    async def ensure_board_items(self) -> None:
        await self._conn.execute(
            """
            DELETE FROM board_items
            WHERE item_type = 'session'
              AND NOT EXISTS (
                  SELECT 1 FROM sessions
                  WHERE sessions.session_id = board_items.item_id
                    AND sessions.folder_id = board_items.folder_id
              )
            """
        )
        await self._conn.execute(
            """
            DELETE FROM board_items
            WHERE item_type = 'subfolder'
              AND NOT EXISTS (
                  SELECT 1 FROM folders
                  WHERE folders.id = board_items.item_id
                    AND folders.parent_folder_id = board_items.folder_id
              )
            """
        )
        await self._conn.execute(
            """
            DELETE FROM board_items
            WHERE item_type = 'markdown'
              AND NOT EXISTS (
                  SELECT 1 FROM markdown_documents
                  WHERE markdown_documents.id = board_items.item_id
              )
            """
        )
        await self._conn.execute(
            """
            DELETE FROM board_items
            WHERE item_type = 'asset'
              AND NOT EXISTS (
                  SELECT 1 FROM file_assets
                  WHERE file_assets.id = board_items.item_id
              )
            """
        )

        cursor = await self._conn.execute(
            """
            SELECT folder_id, 'session' AS item_type, session_id AS item_id,
                   'session:' || session_id AS board_item_id,
                   COALESCE(json_extract(last_message, '$.timestamp'), updated_at, created_at, '') AS activity_at,
                   session_id AS tie_breaker
            FROM sessions
            WHERE folder_id IS NOT NULL
            UNION ALL
            SELECT parent_folder_id AS folder_id, 'subfolder' AS item_type, id AS item_id,
                   'subfolder:' || id AS board_item_id,
                   '' AS activity_at,
                   name AS tie_breaker
            FROM folders
            WHERE parent_folder_id IS NOT NULL
            ORDER BY folder_id, activity_at DESC, item_type ASC, tie_breaker ASC
            """
        )
        rows = await cursor.fetchall()
        index_by_folder: dict[str, int] = {}
        for row in rows:
            folder_id = row["folder_id"]
            item_index = index_by_folder.get(folder_id, 0)
            index_by_folder[folder_id] = item_index + 1
            await self._conn.execute(
                """
                INSERT OR IGNORE INTO board_items
                    (id, folder_id, item_type, item_id, x, y, metadata, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)
                """,
                (
                    row["board_item_id"],
                    folder_id,
                    row["item_type"],
                    row["item_id"],
                    float((item_index % 4) * 160),
                    float((item_index // 4) * 120),
                    _utc_now(),
                    _utc_now(),
                ),
            )
        await self._conn.commit()

    async def get_board_items(self) -> list[dict]:
        cursor = await self._conn.execute(
            """
            SELECT
                bi.*,
                md.title AS markdown_title,
                md.body AS markdown_body,
                fa.storage_key AS asset_storage_key,
                fa.original_name AS asset_original_name,
                fa.mime_type AS asset_mime_type,
                fa.byte_size AS asset_byte_size,
                fa.width AS asset_width,
                fa.height AS asset_height,
                fa.duration_seconds AS asset_duration_seconds
            FROM board_items bi
            LEFT JOIN markdown_documents md
              ON bi.item_type = 'markdown'
             AND bi.item_id = md.id
            LEFT JOIN file_assets fa
              ON bi.item_type = 'asset'
             AND bi.item_id = fa.id
            ORDER BY bi.folder_id, bi.y, bi.x, bi.created_at
            """
        )
        rows = await cursor.fetchall()
        items = []
        for row in rows:
            data = dict(row)
            item = _normalize_board_item(data)
            if item["itemType"] == "markdown":
                item["metadata"] = {
                    **item["metadata"],
                    "title": data.get("markdown_title") or "",
                    "preview": " ".join((data.get("markdown_body") or "").split())[:180],
                }
            if item["itemType"] == "asset":
                item["metadata"] = {
                    **item["metadata"],
                    "assetId": item["itemId"],
                    "storageKey": data.get("asset_storage_key"),
                    "originalName": data.get("asset_original_name"),
                    "mimeType": data.get("asset_mime_type"),
                    "byteSize": data.get("asset_byte_size"),
                    "width": data.get("asset_width"),
                    "height": data.get("asset_height"),
                    "durationSeconds": data.get("asset_duration_seconds"),
                }
            items.append(item)
        return items

    async def get_board_yjs_catalog_items(self, folder_id: Optional[str] = None) -> list[dict]:
        items = await self.get_board_items()
        if folder_id is None:
            return items
        return [item for item in items if item.get("folderId") == folder_id]

    async def update_board_item_position(self, board_item_id: str, x: float, y: float) -> None:
        await self._conn.execute(
            "UPDATE board_items SET x = ?, y = ?, updated_at = ? WHERE id = ?",
            (x, y, _utc_now(), board_item_id),
        )
        await self._conn.commit()

    async def create_markdown_document(
        self,
        document_id: str,
        folder_id: str,
        title: str,
        body: str,
        x: float,
        y: float,
    ) -> dict:
        now = _utc_now()
        await self._conn.execute(
            """
            INSERT INTO markdown_documents (id, title, body, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (document_id, title, body, now, now),
        )
        await self._conn.execute(
            """
            INSERT INTO board_items (id, folder_id, item_type, item_id, x, y, metadata, created_at, updated_at)
            VALUES (?, ?, 'markdown', ?, ?, ?, '{}', ?, ?)
            """,
            (f"markdown:{document_id}", folder_id, document_id, x, y, now, now),
        )
        await self._conn.commit()
        document = await self.get_markdown_document(document_id)
        board_item = {
            "id": f"markdown:{document_id}",
            "folderId": folder_id,
            "itemType": "markdown",
            "itemId": document_id,
            "x": float(x),
            "y": float(y),
            "metadata": {"title": title, "preview": " ".join(body.split())[:180]},
            "createdAt": now,
            "updatedAt": now,
        }
        return {"document": document, "boardItem": board_item}

    async def get_markdown_document(self, document_id: str) -> Optional[dict]:
        cursor = await self._conn.execute(
            "SELECT * FROM markdown_documents WHERE id = ?",
            (document_id,),
        )
        row = await cursor.fetchone()
        return _normalize_markdown_document(dict(row)) if row else None

    async def update_markdown_document(
        self,
        document_id: str,
        title: Optional[str] = None,
        body: Optional[str] = None,
    ) -> Optional[dict]:
        fields: dict[str, object] = {}
        if title is not None:
            fields["title"] = title
        if body is not None:
            fields["body"] = body
        if fields:
            fields["updated_at"] = _utc_now()
            set_clause = ", ".join(f"{name} = ?" for name in fields)
            await self._conn.execute(
                f"UPDATE markdown_documents SET {set_clause} WHERE id = ?",
                [*fields.values(), document_id],
            )
            await self._conn.commit()
        return await self.get_markdown_document(document_id)

    async def delete_markdown_document(self, document_id: str) -> None:
        await self._conn.execute(
            "DELETE FROM markdown_documents WHERE id = ?",
            (document_id,),
        )
        await self._conn.commit()

    async def create_pending_file_asset(
        self,
        asset_id: str,
        storage_key: str,
        original_name: str,
        mime_type: str,
        byte_size: int,
        multipart_upload_id: Optional[str] = None,
    ) -> dict:
        now = _utc_now()
        await self._conn.execute(
            """
            INSERT INTO file_assets (
                id, storage_key, original_name, mime_type, byte_size,
                multipart_upload_id, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (asset_id, storage_key, original_name, mime_type, byte_size, multipart_upload_id, now, now),
        )
        await self._conn.commit()
        asset = await self.get_file_asset(asset_id)
        assert asset is not None
        return asset

    async def get_file_asset(self, asset_id: str) -> Optional[dict]:
        cursor = await self._conn.execute(
            "SELECT * FROM file_assets WHERE id = ?",
            (asset_id,),
        )
        row = await cursor.fetchone()
        return _normalize_file_asset(dict(row)) if row else None

    async def mark_stale_pending_file_assets_garbage_collected(
        self,
        stale_before: datetime,
    ) -> int:
        now = _utc_now()
        cursor = await self._conn.execute(
            """
            UPDATE file_assets
            SET garbage_collected_at = ?,
                updated_at = ?
            WHERE upload_status = 'pending'
              AND garbage_collected_at IS NULL
              AND created_at < ?
            """,
            (now, now, stale_before.isoformat()),
        )
        await self._conn.commit()
        return cursor.rowcount

    async def get_file_asset_daily_bytes(self) -> int:
        today = _utc_now()[:10]
        cursor = await self._conn.execute(
            """
            SELECT COALESCE(SUM(byte_size), 0) AS total
            FROM file_assets
            WHERE substr(created_at, 1, 10) = ?
              AND garbage_collected_at IS NULL
            """,
            (today,),
        )
        row = await cursor.fetchone()
        return int(row["total"]) if row else 0

    async def commit_file_asset(
        self,
        asset_id: str,
        folder_id: str,
        x: float,
        y: float,
        width: Optional[int] = None,
        height: Optional[int] = None,
        duration_seconds: Optional[float] = None,
    ) -> dict:
        now = _utc_now()
        cursor = await self._conn.execute(
            """
            UPDATE file_assets
            SET upload_status = 'committed',
                width = COALESCE(?, width),
                height = COALESCE(?, height),
                duration_seconds = COALESCE(?, duration_seconds),
                updated_at = ?
            WHERE id = ?
              AND garbage_collected_at IS NULL
            """,
            (width, height, duration_seconds, now, asset_id),
        )
        if cursor.rowcount == 0:
            await self._conn.commit()
            raise ValueError(f"file asset not found: {asset_id}")
        asset = await self.get_file_asset(asset_id)
        if asset is None:
            raise ValueError(f"file asset not found: {asset_id}")
        metadata = {
            "assetId": asset["id"],
            "storageKey": asset["storageKey"],
            "originalName": asset["originalName"],
            "mimeType": asset["mimeType"],
            "byteSize": asset["byteSize"],
            "width": asset["width"],
            "height": asset["height"],
            "durationSeconds": asset["durationSeconds"],
        }
        await self._conn.execute(
            """
            INSERT INTO board_items (id, folder_id, item_type, item_id, x, y, metadata, created_at, updated_at)
            VALUES (?, ?, 'asset', ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                folder_id = excluded.folder_id,
                x = excluded.x,
                y = excluded.y,
                metadata = excluded.metadata,
                updated_at = excluded.updated_at
            """,
            (
                f"asset:{asset_id}",
                folder_id,
                asset_id,
                x,
                y,
                json.dumps(metadata, ensure_ascii=False),
                now,
                now,
            ),
        )
        await self._conn.commit()
        items = [
            item for item in await self.get_board_items()
            if item["id"] == f"asset:{asset_id}"
        ]
        return {"asset": asset, "boardItem": items[0]}

    async def _validate_parent_folder(
        self,
        folder_id: str,
        parent_folder_id: Optional[str],
    ) -> None:
        if parent_folder_id is None:
            return
        if folder_id == parent_folder_id:
            raise ValueError("folder parent cycle")

        cursor = await self._conn.execute(
            "SELECT id, parent_folder_id FROM folders"
        )
        rows = await cursor.fetchall()
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
