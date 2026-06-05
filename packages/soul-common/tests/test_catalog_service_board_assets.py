from pathlib import Path
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio

from soul_common.catalog.board_asset_storage import (
    CompletedUploadPart,
    MultipartUploadInit,
    MultipartUploadPart,
    ObjectHead,
)
from soul_common.catalog.catalog_service import CatalogService
from soul_common.db.sqlite_session_db import SqliteSessionDB

_SCHEMA_PATH = (
    Path(__file__).resolve().parent.parent
    / "src" / "soul_common" / "db" / "sqlite_schema.sql"
)


class FakeBroadcaster:
    def __init__(self) -> None:
        self.events = []

    async def broadcast(self, event: dict) -> int:
        self.events.append(event)
        return 1

    async def emit_session_deleted(self, agent_session_id: str) -> int:
        self.events.append({"type": "session_deleted", "sessionId": agent_session_id})
        return 1


class FakeBoardAssetStorage:
    def __init__(self) -> None:
        self.put_urls = []
        self.completed_parts: list[CompletedUploadPart] = []
        self.heads: dict[str, ObjectHead] = {}

    def create_presigned_put_url(self, *, storage_key: str, mime_type: str, expires_seconds: int) -> str:
        self.put_urls.append((storage_key, mime_type, expires_seconds))
        return f"https://r2.example/put/{storage_key}"

    def create_multipart_upload(
        self,
        *,
        storage_key: str,
        mime_type: str,
        byte_size: int,
        part_size: int,
        expires_seconds: int,
    ) -> MultipartUploadInit:
        parts = [
            MultipartUploadPart(part_number=1, upload_url=f"https://r2.example/part-1/{storage_key}"),
            MultipartUploadPart(part_number=2, upload_url=f"https://r2.example/part-2/{storage_key}"),
        ]
        return MultipartUploadInit(upload_id="upload-1", part_size=part_size, parts=parts)

    def complete_multipart_upload(
        self,
        *,
        storage_key: str,
        upload_id: str,
        parts: list[CompletedUploadPart],
    ) -> None:
        self.completed_parts = parts

    def head_object(self, *, storage_key: str) -> ObjectHead:
        return self.heads[storage_key]

    def create_presigned_get_url(self, *, storage_key: str, expires_seconds: int) -> str:
        return f"https://r2.example/get/{storage_key}"


@pytest_asyncio.fixture
async def db():
    instance = SqliteSessionDB(
        db_path=":memory:",
        node_id="test-node",
        schema_path=_SCHEMA_PATH,
    )
    await instance.connect()
    await instance.create_folder("f1", "Folder 1")
    yield instance
    await instance.close()


@pytest.mark.asyncio
async def test_board_asset_init_and_commit_uses_r2_head_before_board_item(db: SqliteSessionDB):
    storage = FakeBoardAssetStorage()
    service = CatalogService(db, FakeBroadcaster(), asset_storage=storage)

    init = await service.init_file_asset(
        folder_id="f1",
        name="photo.png",
        mime_type="image/png",
        byte_size=123,
    )
    assert init["uploadMode"] == "single"
    assert init["uploadUrl"].startswith("https://r2.example/put/folders/f1/assets/")
    assert [item for item in await db.get_board_items() if item["itemType"] == "asset"] == []

    storage.heads[init["storageKey"]] = ObjectHead(byte_size=123, mime_type="image/png")
    committed = await service.commit_file_asset(
        folder_id="f1",
        asset_id=init["assetId"],
        x=41,
        y=79,
        width=640,
        height=480,
    )

    assert committed["boardItem"]["id"] == f"asset:{init['assetId']}"
    assert committed["boardItem"]["x"] == 40.0
    assert committed["boardItem"]["y"] == 80.0
    assert committed["boardItem"]["metadata"]["signedUrl"].startswith("https://r2.example/get/")

    stored = await db.get_board_items()
    asset_item = next(item for item in stored if item["id"] == committed["boardItem"]["id"])
    assert "signedUrl" not in asset_item["metadata"]


@pytest.mark.asyncio
async def test_board_asset_multipart_commit_forwards_parts(db: SqliteSessionDB):
    storage = FakeBoardAssetStorage()
    service = CatalogService(db, FakeBroadcaster(), asset_storage=storage)

    init = await service.init_file_asset(
        folder_id="f1",
        name="clip.mp4",
        mime_type="video/mp4",
        byte_size=6 * 1024 * 1024,
    )
    assert init["uploadMode"] == "multipart"
    storage.heads[init["storageKey"]] = ObjectHead(byte_size=6 * 1024 * 1024, mime_type="video/mp4")

    await service.commit_file_asset(
        folder_id="f1",
        asset_id=init["assetId"],
        x=0,
        y=0,
        parts=[
            {"partNumber": 1, "etag": "etag-1"},
            {"partNumber": 2, "etag": "etag-2"},
        ],
    )

    assert storage.completed_parts == [
        CompletedUploadPart(part_number=1, etag="etag-1"),
        CompletedUploadPart(part_number=2, etag="etag-2"),
    ]


@pytest.mark.asyncio
async def test_board_asset_init_marks_stale_pending_assets_garbage_collected(db: SqliteSessionDB):
    storage = FakeBoardAssetStorage()
    service = CatalogService(db, FakeBroadcaster(), asset_storage=storage)

    stale = await db.create_pending_file_asset(
        "asset-stale",
        "folders/f1/assets/asset-stale/old.bin",
        "old.bin",
        "application/octet-stream",
        100,
    )
    stale_created_at = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    await db._conn.execute(
        "UPDATE file_assets SET created_at = ?, updated_at = ? WHERE id = ?",
        (stale_created_at, stale_created_at, stale["id"]),
    )
    await db._conn.commit()

    await service.init_file_asset(
        folder_id="f1",
        name="new.bin",
        mime_type="application/octet-stream",
        byte_size=10,
    )

    collected = await db.get_file_asset("asset-stale")
    assert collected is not None
    assert collected["garbageCollectedAt"] is not None

    storage.heads[stale["storageKey"]] = ObjectHead(byte_size=100, mime_type="application/octet-stream")
    with pytest.raises(ValueError, match="file asset not found"):
        await service.commit_file_asset(
            folder_id="f1",
            asset_id=stale["id"],
            x=0,
            y=0,
        )
    assert [item for item in await db.get_board_items() if item["itemType"] == "asset"] == []
