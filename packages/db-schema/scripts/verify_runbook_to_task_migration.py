#!/usr/bin/env python3
"""Prove that migration 042 preserves every work-task relationship.

Capture a read-only snapshot immediately before applying 042, then compare it
afterward. The comparison normalizes only the contract vocabulary that 042 is
supposed to rename; identifiers, user content, ordering, timestamps, and links
must remain byte-for-byte equivalent after canonical JSON serialization.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from collections import Counter
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence
from uuid import UUID


class VerificationError(RuntimeError):
    """Raised when the migration changes data outside the rename contract."""


def _json_default(value: Any) -> str:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, bytes):
        return value.hex()
    raise TypeError(f"unsupported snapshot value: {type(value).__name__}")


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=_json_default,
    ).encode("utf-8")


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def _decode_json(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def _normalize_json_contract(value: Any) -> Any:
    if isinstance(value, list):
        return [_normalize_json_contract(item) for item in value]
    if not isinstance(value, dict):
        return value

    normalized: dict[str, Any] = {}
    for key, item in value.items():
        work_key = {
            "runbookId": "workId",
            "taskId": "workId",
            "sourceRunbookItemId": "sourceWorkItemId",
            "sourceTaskItemId": "sourceWorkItemId",
        }.get(key, key)
        normalized_item = _normalize_json_contract(item)
        if work_key in {"itemType", "containerKind"} and normalized_item in {
            "runbook",
            "task",
        }:
            normalized_item = "work"
        normalized[work_key] = normalized_item
    return normalized


def normalize_row(table: str, row: Mapping[str, Any]) -> dict[str, Any]:
    """Normalize only renamed schema vocabulary, never user-authored text."""

    normalized: dict[str, Any] = {}
    for key, raw_value in row.items():
        value = _decode_json(raw_value)
        work_key = {
            "runbook_id": "work_id",
            "task_id": "work_id",
            "source_runbook_item_id": "source_work_item_id",
            "source_task_item_id": "source_work_item_id",
        }.get(key, key)

        if table == "operations" and key == "target_kind" and value in {
            "runbook",
            "task",
        }:
            value = "work"
        elif table == "operations" and key == "operation_type":
            value = value.replace("runbook", "work").replace("task", "work")
        elif table == "board_items" and key in {"item_type", "container_kind"}:
            if value in {"runbook", "task"}:
                value = "work"
        elif table == "catalog_cache" and key == "container_kind":
            if value in {"runbook", "task"}:
                value = "work"
        elif table in {"bindings", "session_links"} and key == "legacy_container_kind":
            if value in {"runbook", "task"}:
                value = "work"
        elif table == "blocks" and key == "block_type":
            if value in {"runbook_ref", "task_ref"}:
                value = "work_ref"
        elif table == "folders" and key == "name":
            if value in {"📒 런북", "📋 업무"}:
                value = "__WORK_FOLDER__"

        if table in {"catalog_cache", "blocks"} and key in {
            "board_items",
            "properties",
        }:
            value = _normalize_json_contract(value)
        normalized[work_key] = value
    return normalized


async def _relation_kind(db: Any, name: str) -> str | None:
    return await db.fetchval(
        "SELECT relkind::text FROM pg_class WHERE oid = to_regclass($1)", name
    )


async def detect_vocabulary(db: Any) -> str:
    if await _relation_kind(db, "tasks") in {"r", "p"}:
        return "task"
    if await _relation_kind(db, "runbooks") in {"r", "p"}:
        return "runbook"
    raise VerificationError("neither canonical tasks nor legacy runbooks table exists")


async def _fetch_rows(db: Any, query: str) -> list[dict[str, Any]]:
    return [dict(row) for row in await db.fetch(query)]


async def collect_snapshot(db: Any) -> dict[str, Any]:
    vocabulary = await detect_vocabulary(db)
    prefix = "task" if vocabulary == "task" else "runbook"
    source_column = f"source_{prefix}_item_id"
    work_table = "tasks" if vocabulary == "task" else "runbooks"

    queries = {
        "work": f"SELECT * FROM {work_table} ORDER BY id",
        "sections": f"SELECT * FROM {prefix}_sections ORDER BY id",
        "items": f"SELECT * FROM {prefix}_items ORDER BY id",
        "operations": f"SELECT * FROM {prefix}_operations ORDER BY id",
        "board_items": "SELECT * FROM board_items ORDER BY id",
        "catalog_cache": (
            "SELECT * FROM board_yjs_catalog_cache "
            "ORDER BY container_kind, container_id"
        ),
        "bindings": "SELECT * FROM session_page_bindings ORDER BY session_id",
        "blocks": (
            "SELECT * FROM blocks "
            "WHERE block_type IN ('runbook_ref','task_ref') "
            "OR properties ? 'runbookId' OR properties ? 'taskId' ORDER BY id"
        ),
        "folders": (
            "SELECT * FROM folders WHERE name IN ('📒 런북','📋 업무') ORDER BY id"
        ),
        "outbox": (
            f"SELECT * FROM checklist_{prefix}_projection_outbox ORDER BY block_id"
        ),
        "documents": (
            "SELECT DISTINCT document.* FROM markdown_documents document "
            "JOIN board_items item ON item.item_type = 'markdown' "
            "AND item.item_id = document.id "
            f"WHERE item.container_kind = '{prefix}' ORDER BY document.id"
        ),
        "assets": (
            "SELECT DISTINCT asset.* FROM file_assets asset "
            "JOIN board_items item ON item.item_type = 'asset' "
            "AND item.item_id = asset.id "
            f"WHERE item.container_kind = '{prefix}' ORDER BY asset.id"
        ),
        "pages": (
            f"SELECT DISTINCT page.* FROM pages page JOIN {work_table} work "
            "ON work.task_page_id = page.id ORDER BY page.id"
        ),
        "session_links": (
            "SELECT session_id, node_id, legacy_container_kind, legacy_container_id, "
            f"{source_column} FROM session_page_bindings "
            f"WHERE legacy_container_kind = '{prefix}' "
            f"OR {source_column} IS NOT NULL ORDER BY session_id"
        ),
    }

    rows: dict[str, list[dict[str, Any]]] = {}
    for table, query in queries.items():
        rows[table] = [
            normalize_row(table, row) for row in await _fetch_rows(db, query)
        ]

    status_distribution = Counter(row["status"] for row in rows["work"])
    item_status_distribution = Counter(row["status"] for row in rows["items"])
    counts = {name: len(table_rows) for name, table_rows in rows.items()}
    summary = {
        "counts": counts,
        "work_status": dict(sorted(status_distribution.items())),
        "item_status": dict(sorted(item_status_distribution.items())),
        "archived_work": sum(bool(row["archived"]) for row in rows["work"]),
    }
    return {"schema": "work-task-migration-snapshot.v1", "summary": summary, "rows": rows}


def compare_snapshots(before: Mapping[str, Any], after: Mapping[str, Any]) -> dict[str, Any]:
    before_digest = canonical_sha256(before)
    after_digest = canonical_sha256(after)
    if before_digest != after_digest:
        differing = sorted(
            name
            for name in set(before.get("rows", {})) | set(after.get("rows", {}))
            if before.get("rows", {}).get(name) != after.get("rows", {}).get(name)
        )
        raise VerificationError(
            "migration snapshot differs in: " + ", ".join(differing or ["summary"])
        )
    return {
        "status": "ok",
        "sha256": before_digest,
        "summary": before["summary"],
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database-url", required=True)
    parser.add_argument("--snapshot", required=True, type=Path)
    parser.add_argument("--mode", required=True, choices=("baseline", "verify"))
    return parser


async def _run(args: argparse.Namespace) -> dict[str, Any]:
    import asyncpg

    connection = await asyncpg.connect(args.database_url)
    try:
        snapshot = await collect_snapshot(connection)
    finally:
        await connection.close()

    if args.mode == "baseline":
        args.snapshot.parent.mkdir(parents=True, exist_ok=True)
        args.snapshot.write_bytes(canonical_json_bytes(snapshot) + b"\n")
        return {
            "status": "baseline-written",
            "sha256": canonical_sha256(snapshot),
            "summary": snapshot["summary"],
        }

    before = json.loads(args.snapshot.read_text(encoding="utf-8"))
    return compare_snapshots(before, snapshot)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        report = asyncio.run(_run(args))
    except VerificationError as exc:
        print(json.dumps({"status": "error", "message": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, default=_json_default))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
