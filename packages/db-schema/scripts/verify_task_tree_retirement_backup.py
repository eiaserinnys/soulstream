#!/usr/bin/env python3
"""Verify the persisted v1 Task Tree retirement backup.

Export each Soulstream Markdown document body as a UTF-8 JSON file, then run:

    python3 packages/db-schema/scripts/verify_task_tree_retirement_backup.py \
      --chunk chunk-1.json --chunk chunk-2.json \
      --chunk chunk-3.json --chunk chunk-4.json \
      --manifest manifest.json

The checksum target is each parsed document's ``tasks`` array. Object keys are
sorted recursively by ``json.dumps(sort_keys=True)``; array order is preserved.
The four chunk arrays are combined in ``chunk_index`` order.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence


CANONICALIZATION = (
    "UTF-8 JSON; object keys recursively sorted; arrays preserved; "
    "compact separators ',' and ':'; ensure_ascii=false; target=root.tasks"
)
NONTERMINAL_STATUSES = frozenset({"open", "in_progress", "blocked", "agent_done"})
MANIFEST_TASK_FIELDS = (
    "id",
    "parent_id",
    "position_key",
    "title",
    "status",
    "linked_session_id",
    "linked_node_id",
    "navigation_session_id",
    "navigation_node_id",
    "navigation_event_id",
    "created_from_session_id",
    "created_from_event_id",
)


@dataclass(frozen=True)
class Expectations:
    chunk_sha256: Mapping[int, str]
    combined_sha256: str
    manifest_sha256: str
    task_count: int
    operation_count: int
    manifest_count: int
    status_distribution: Mapping[str, int]


EXPECTED = Expectations(
    chunk_sha256={
        1: "74bc4d6216ea85265ae9d1042b0ecd972554330ebc419d3b1cf61cb1d4d64ad5",
        2: "e2db777507d349a91ce5ad5f0e3139f9070f70cf61cd1324b25bb07baa6822c9",
        3: "a003094e1b14a1b27aed1472a7e8f6cda2e5cafa37a3f24852cc04f688e2b711",
        4: "f3ca415b7719de855184f0823d996f043caa694569ca9b64a4616b18102e0e74",
    },
    combined_sha256="041758615e4423d06c5e95c130c50c55541884b38a1431264bfadb561314c01c",
    manifest_sha256="d7a4a531c3905c894de408093ee1409208e9565027b6c604f62c94d6a64cfcd8",
    task_count=199,
    operation_count=589,
    manifest_count=98,
    status_distribution={
        "verified_done": 96,
        "agent_done": 45,
        "in_progress": 45,
        "open": 6,
        "cancelled": 5,
        "blocked": 2,
    },
)


class VerificationError(RuntimeError):
    """Raised when persisted backup data does not match its contract."""


def canonical_json_bytes(value: Any) -> bytes:
    """Return the one canonical byte representation used by this backup."""

    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise VerificationError(message)


def _task_id(entry: Mapping[str, Any]) -> str:
    task = entry.get("task")
    _require(isinstance(task, dict), "chunk entry is missing object field 'task'")
    task_id = task.get("id")
    _require(isinstance(task_id, str) and task_id, "chunk task is missing a string id")
    return task_id


def _expected_manifest_entry(entry: Mapping[str, Any]) -> dict[str, Any]:
    task = entry["task"]
    path = entry.get("path")
    _require(isinstance(task, dict), "chunk entry task must be an object")
    _require(isinstance(path, list), f"task {task.get('id')} path must be an array")
    compact_path: list[dict[str, Any]] = []
    for item in path:
        _require(
            isinstance(item, dict),
            f"task {task.get('id')} path item must be an object",
        )
        compact_path.append({"id": item.get("id"), "title": item.get("title")})
    return {field: task.get(field) for field in MANIFEST_TASK_FIELDS} | {
        "path": compact_path
    }


def verify_backup(
    chunk_roots: Sequence[Mapping[str, Any]],
    manifest_root: Mapping[str, Any],
    expectations: Expectations = EXPECTED,
) -> dict[str, Any]:
    """Verify counts, hashes, status distribution, and recovery manifest."""

    sorted_chunks = sorted(chunk_roots, key=lambda root: root.get("chunk_index", -1))
    indices = [root.get("chunk_index") for root in sorted_chunks]
    _require(
        indices == sorted(expectations.chunk_sha256),
        f"chunk indices differ: expected {sorted(expectations.chunk_sha256)}, got {indices}",
    )

    all_entries: list[Mapping[str, Any]] = []
    chunk_report: list[dict[str, Any]] = []
    operation_count = 0
    for root in sorted_chunks:
        chunk_index = root["chunk_index"]
        tasks = root.get("tasks")
        _require(isinstance(tasks, list), f"chunk {chunk_index} tasks must be an array")
        task_count = len(tasks)
        actual_operations = 0
        for entry in tasks:
            _require(isinstance(entry, dict), f"chunk {chunk_index} entry must be an object")
            operations = entry.get("operations")
            _require(
                isinstance(operations, list),
                f"chunk {chunk_index} task {_task_id(entry)} operations must be an array",
            )
            actual_operations += len(operations)
        _require(
            task_count == root.get("task_count"),
            f"chunk {chunk_index} declared task_count differs from stored tasks",
        )
        _require(
            actual_operations == root.get("operation_count"),
            f"chunk {chunk_index} declared operation_count differs from stored operations",
        )
        digest = canonical_sha256(tasks)
        _require(
            digest == expectations.chunk_sha256[chunk_index],
            f"chunk {chunk_index} checksum differs: {digest}",
        )
        checksum_metadata = root.get("checksum")
        _require(
            isinstance(checksum_metadata, dict),
            f"chunk {chunk_index} checksum metadata missing",
        )
        _require(
            checksum_metadata.get("algorithm") == "sha256"
            and checksum_metadata.get("target") == "tasks"
            and checksum_metadata.get("canonicalization") == CANONICALIZATION
            and checksum_metadata.get("sha256") == digest,
            f"chunk {chunk_index} checksum metadata differs",
        )
        all_entries.extend(tasks)
        operation_count += actual_operations
        chunk_report.append(
            {
                "chunk_index": chunk_index,
                "task_count": task_count,
                "operation_count": actual_operations,
                "tasks_sha256": digest,
            }
        )

    task_ids = [_task_id(entry) for entry in all_entries]
    _require(len(task_ids) == len(set(task_ids)), "duplicate task ids exist in chunks")
    _require(len(all_entries) == expectations.task_count, "combined task count differs")
    _require(operation_count == expectations.operation_count, "combined operation count differs")

    status_distribution = Counter(entry["task"].get("status") for entry in all_entries)
    _require(
        status_distribution == Counter(expectations.status_distribution),
        f"status distribution differs: {dict(status_distribution)}",
    )
    combined_digest = canonical_sha256(all_entries)
    _require(
        combined_digest == expectations.combined_sha256,
        f"combined checksum differs: {combined_digest}",
    )

    manifest_tasks = manifest_root.get("tasks")
    _require(isinstance(manifest_tasks, list), "manifest tasks must be an array")
    _require(
        len(manifest_tasks) == manifest_root.get("task_count") == expectations.manifest_count,
        "manifest task count differs",
    )
    manifest_digest = canonical_sha256(manifest_tasks)
    _require(
        manifest_digest == expectations.manifest_sha256,
        f"manifest checksum differs: {manifest_digest}",
    )
    manifest_checksum = manifest_root.get("checksum")
    _require(isinstance(manifest_checksum, dict), "manifest checksum metadata missing")
    _require(
        manifest_checksum.get("algorithm") == "sha256"
        and manifest_checksum.get("target") == "tasks"
        and manifest_checksum.get("canonicalization") == CANONICALIZATION
        and manifest_checksum.get("sha256") == manifest_digest,
        "manifest checksum metadata differs",
    )

    source_nonterminal = {
        _task_id(entry): _expected_manifest_entry(entry)
        for entry in all_entries
        if entry["task"].get("status") in NONTERMINAL_STATUSES
    }
    stored_manifest = {
        item.get("id"): item for item in manifest_tasks if isinstance(item, dict)
    }
    _require(
        len(stored_manifest) == len(manifest_tasks),
        "manifest contains a non-object task or duplicate task id",
    )
    _require(
        set(stored_manifest) == set(source_nonterminal),
        "manifest task ids differ from nonterminal chunk tasks",
    )
    for task_id, expected_item in source_nonterminal.items():
        _require(
            stored_manifest[task_id] == expected_item,
            f"manifest recovery fields differ for task {task_id}",
        )

    return {
        "canonicalization": CANONICALIZATION,
        "chunks": chunk_report,
        "task_count": len(all_entries),
        "operation_count": operation_count,
        "status_distribution": dict(sorted(status_distribution.items())),
        "combined_sha256": combined_digest,
        "manifest_count": len(manifest_tasks),
        "manifest_sha256": manifest_digest,
        "result": "verified",
    }


def _load_json(path: Path) -> Mapping[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    _require(isinstance(value, dict), f"{path} root must be a JSON object")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--chunk",
        action="append",
        required=True,
        type=Path,
        help="Path to a persisted chunk document body; repeat four times",
    )
    parser.add_argument(
        "--manifest",
        required=True,
        type=Path,
        help="Path to the persisted recovery manifest document body",
    )
    args = parser.parse_args()

    try:
        report = verify_backup(
            [_load_json(path) for path in args.chunk],
            _load_json(args.manifest),
        )
    except (OSError, json.JSONDecodeError, VerificationError) as exc:
        print(f"verification failed: {exc}")
        return 1

    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
