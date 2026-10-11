"""P1 attachment storage migration contracts."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
from pathlib import Path

import pytest


MIGRATION_ID = "122_attachment_storage_contract.sql"


def _schema_name() -> str:
    import secrets

    return f"attachment_test_{secrets.token_hex(6)}"


async def _connect_test_database(url: str):
    import asyncpg

    deadline = asyncio.get_running_loop().time() + 30
    last_error: Exception | None = None
    while asyncio.get_running_loop().time() < deadline:
        try:
            return await asyncpg.connect(url)
        except Exception as exc:
            last_error = exc
            await asyncio.sleep(0.5)
    assert last_error is not None
    raise last_error


@pytest.mark.asyncio
async def test_attachment_migration_preserves_legacy_data_and_enforces_refs(
    test_database_url: str,
) -> None:
    import asyncpg

    schema_name = _schema_name()
    admin = await _connect_test_database(test_database_url)
    try:
        await admin.execute(f'CREATE SCHEMA "{schema_name}"')
    finally:
        await admin.close()

    conn = await asyncpg.connect(
        test_database_url,
        server_settings={"search_path": schema_name},
    )
    try:
        await conn.execute(
            """
            CREATE TABLE file_assets (
                id TEXT PRIMARY KEY,
                storage_key TEXT NOT NULL UNIQUE,
                original_name TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
                width INTEGER,
                height INTEGER,
                duration_seconds DOUBLE PRECISION,
                checksum_sha256 TEXT,
                upload_status TEXT NOT NULL DEFAULT 'pending'
                    CHECK (upload_status IN ('pending', 'committed')),
                multipart_upload_id TEXT,
                garbage_collected_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE TABLE sessions (session_id TEXT PRIMARY KEY);
            CREATE TABLE cards (
                id TEXT PRIMARY KEY,
                request TEXT NOT NULL,
                attachments JSONB NOT NULL DEFAULT '[]'::jsonb
            );
            CREATE TABLE card_reports (
                id TEXT PRIMARY KEY,
                body TEXT NOT NULL
            );
            CREATE TABLE card_comments (
                id TEXT PRIMARY KEY,
                body TEXT NOT NULL
            );
            INSERT INTO file_assets (
                id, storage_key, original_name, mime_type, byte_size,
                width, height, checksum_sha256, upload_status
            ) VALUES (
                'board-asset', 'boards/folder-1/asset-1', 'old.png', 'image/png', 256,
                16, 16, 'old-checksum', 'committed'
            );
            INSERT INTO sessions (session_id) VALUES ('source-session');
            INSERT INTO cards (id, request, attachments)
            VALUES ('card-1', 'old request', '[{"path":"legacy/file"}]'::jsonb);
            INSERT INTO card_reports (id, body) VALUES ('report-1', 'old report');
            INSERT INTO card_comments (id, body) VALUES ('comment-1', 'old comment');
            """
        )

        migration_path = Path(__file__).resolve().parents[1] / "sql" / "migrations" / MIGRATION_ID
        await conn.execute(migration_path.read_text(encoding="utf-8"))

        board_asset = await conn.fetchrow(
            """
            SELECT storage_key, original_name, mime_type, byte_size, width, height,
                   checksum_sha256, upload_status, storage_purpose,
                   storage_endpoint, storage_bucket
            FROM file_assets WHERE id = 'board-asset'
            """
        )
        assert dict(board_asset) == {
            "storage_key": "boards/folder-1/asset-1",
            "original_name": "old.png",
            "mime_type": "image/png",
            "byte_size": 256,
            "width": 16,
            "height": 16,
            "checksum_sha256": "old-checksum",
            "upload_status": "committed",
            "storage_purpose": "board",
            "storage_endpoint": None,
            "storage_bucket": None,
        }

        await conn.execute(
            """
            INSERT INTO file_assets (
                id, storage_key, original_name, mime_type, byte_size,
                upload_status, storage_purpose, owner_kind, owner_key,
                registration_scope, source_node_id, source_session_id,
                output_command_id
            ) VALUES (
                'attachment-asset', 'attachments/user-1/asset-1', 'new.txt',
                'text/plain', 12, 'committed', 'attachment', 'user_email',
                'user@example.test', '{"type":"session","id":"session-1"}'::jsonb,
                'node-1', 'source-session', 'command-1'
            );
            INSERT INTO attachment_legacy_aliases (
                node_id, normalized_path, asset_id, original_path, availability
            ) VALUES (
                'node-1', 'normalized/file', 'attachment-asset',
                'Original/file', 'resolved'
            );
            INSERT INTO attachment_legacy_aliases (
                node_id, normalized_path, asset_id, original_path, availability
            ) VALUES (
                'node-1', 'missing/file', NULL, 'Missing/file', 'missing'
            );
            """
        )

        with pytest.raises(asyncpg.CheckViolationError):
            await conn.execute(
                "UPDATE file_assets SET owner_kind = 'unknown' WHERE id = 'attachment-asset'"
            )

        with pytest.raises(asyncpg.CheckViolationError):
            await conn.execute(
                "UPDATE file_assets SET storage_purpose = 'unknown' WHERE id = 'board-asset'"
            )

        with pytest.raises(asyncpg.CheckViolationError):
            await conn.execute(
                """
                INSERT INTO attachment_legacy_aliases (
                    node_id, normalized_path, asset_id, original_path, availability
                ) VALUES ('node-1', 'bad-resolved', NULL, 'Bad/resolved', 'resolved')
                """
            )

        with pytest.raises(asyncpg.CheckViolationError):
            await conn.execute(
                """
                INSERT INTO attachment_legacy_aliases (
                    node_id, normalized_path, asset_id, original_path, availability
                ) VALUES (
                    'node-1', 'bad-missing', 'attachment-asset', 'Bad/missing', 'missing'
                )
                """
            )

        await conn.execute("DELETE FROM sessions WHERE session_id = 'source-session'")
        assert await conn.fetchval(
            "SELECT source_session_id FROM file_assets WHERE id = 'attachment-asset'"
        ) == "source-session"
        assert await conn.fetchval(
            "SELECT COUNT(*) FROM attachment_legacy_aliases WHERE availability = 'missing' AND asset_id IS NULL"
        ) == 1

        for table, row_id, expected_body in (
            ("cards", "card-1", "old request"),
            ("card_reports", "report-1", "old report"),
            ("card_comments", "comment-1", "old comment"),
        ):
            body_column = "request" if table == "cards" else "body"
            row = await conn.fetchrow(
                f"SELECT {body_column}, attachment_refs FROM {table} WHERE id = $1",
                row_id,
            )
            assert row[body_column] == expected_body
            assert json.loads(row["attachment_refs"]) == []
        assert json.loads(
            await conn.fetchval("SELECT attachments FROM cards WHERE id = 'card-1'")
        ) == [{"path": "legacy/file"}]

        with pytest.raises(asyncpg.ForeignKeyViolationError):
            await conn.execute("DELETE FROM file_assets WHERE id = 'attachment-asset'")

        for table, row_id in (
            ("cards", "card-1"),
            ("card_reports", "report-1"),
            ("card_comments", "comment-1"),
        ):
            with pytest.raises(asyncpg.CheckViolationError):
                await conn.execute(
                    f"UPDATE {table} SET attachment_refs = '{{}}'::jsonb WHERE id = $1",
                    row_id,
                )
    finally:
        await conn.close()
        admin = await _connect_test_database(test_database_url)
        try:
            await admin.execute(f'DROP SCHEMA IF EXISTS "{schema_name}" CASCADE')
        finally:
            await admin.close()


def test_migration_preflight_loads_manifest_with_new_migration(test_database_url: str) -> None:
    async def wait_for_database() -> None:
        conn = await _connect_test_database(test_database_url)
        await conn.close()

    asyncio.run(wait_for_database())
    repo_root = Path(__file__).resolve().parents[3]
    env = {
        **os.environ,
        "DATABASE_URL": test_database_url,
        "SOULSTREAM_RELEASE_ID": "test-attachment-storage-contract",
        "HANIEL_SERVICE_ENV_FILE": "/dev/null",
    }
    result = subprocess.run(
        ["node", str(repo_root / "packages/db-schema/scripts/migrate.mjs"), "preflight"],
        cwd=repo_root,
        env=env,
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["status"] == "ok"
    assert MIGRATION_ID in report["bootstrap"] + report["pending"]


@pytest.mark.asyncio
async def test_canonical_schema_has_attachment_storage_columns(test_db) -> None:
    async with test_db.acquire() as conn:
        tables = await conn.fetch(
            """
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND (
                  (table_name = 'file_assets' AND column_name IN (
                      'storage_purpose', 'storage_endpoint', 'storage_bucket', 'owner_kind',
                      'owner_key', 'registration_scope', 'source_node_id',
                      'source_session_id', 'output_command_id'
                  ))
                  OR (table_name IN ('cards', 'card_reports', 'card_comments')
                      AND column_name = 'attachment_refs')
              )
            """
        )
        columns = {(row["table_name"], row["column_name"]) for row in tables}
        assert {
            ("file_assets", name)
            for name in (
                "storage_purpose",
                "storage_endpoint",
                "storage_bucket",
                "owner_kind",
                "owner_key",
                "registration_scope",
                "source_node_id",
                "source_session_id",
                "output_command_id",
            )
        }.issubset(columns)
        assert {
            (table, "attachment_refs")
            for table in ("cards", "card_reports", "card_comments")
        }.issubset(columns)
        assert await conn.fetchval("SELECT to_regclass('attachment_legacy_aliases')")
