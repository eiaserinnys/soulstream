"""Regression tests for the retired Task Tree backup verifier."""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from verify_task_tree_retirement_backup import (  # noqa: E402
    CANONICALIZATION,
    Expectations,
    canonical_sha256,
    verify_backup,
)


def _entry(task_id: str, status: str) -> dict[str, object]:
    task = {
        "id": task_id,
        "parent_id": None,
        "position_key": 1,
        "title": f"태스크 {task_id}",
        "status": status,
        "linked_session_id": f"session-{task_id}",
        "linked_node_id": "node-a",
        "navigation_session_id": f"session-{task_id}",
        "navigation_node_id": "node-a",
        "navigation_event_id": 2,
        "created_from_session_id": f"creator-{task_id}",
        "created_from_event_id": 1,
    }
    return {
        "task": task,
        "path": [{"id": task_id, "title": task["title"]}],
        "operations": [{"id": f"operation-{task_id}", "task_id": task_id}],
    }


def _manifest_entry(entry: dict[str, object]) -> dict[str, object]:
    task = entry["task"]
    assert isinstance(task, dict)
    return {
        key: task.get(key)
        for key in (
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
    } | {"path": entry["path"]}


def test_canonical_sha256_sorts_object_keys_but_preserves_array_order() -> None:
    left = [{"한글": 1, "a": 2}, {"z": 3}]
    same = [{"a": 2, "한글": 1}, {"z": 3}]
    reversed_array = list(reversed(same))

    assert canonical_sha256(left) == canonical_sha256(same)
    assert canonical_sha256(left) != canonical_sha256(reversed_array)


def test_verify_backup_recomputes_stored_tasks_and_manifest() -> None:
    first = _entry("a", "agent_done")
    second = _entry("b", "verified_done")
    chunk_roots = [
        {
            "chunk_index": 1,
            "task_count": 1,
            "operation_count": 1,
            "tasks": [first],
        },
        {
            "chunk_index": 2,
            "task_count": 1,
            "operation_count": 1,
            "tasks": [second],
        },
    ]
    for root in chunk_roots:
        root["checksum"] = {
            "algorithm": "sha256",
            "canonicalization": CANONICALIZATION,
            "target": "tasks",
            "sha256": canonical_sha256(root["tasks"]),
        }

    manifest_root = {
        "task_count": 1,
        "tasks": [_manifest_entry(first)],
    }
    manifest_root["checksum"] = {
        "algorithm": "sha256",
        "canonicalization": CANONICALIZATION,
        "target": "tasks",
        "sha256": canonical_sha256(manifest_root["tasks"]),
    }

    expectations = Expectations(
        chunk_sha256={
            1: canonical_sha256(chunk_roots[0]["tasks"]),
            2: canonical_sha256(chunk_roots[1]["tasks"]),
        },
        combined_sha256=canonical_sha256([first, second]),
        manifest_sha256=canonical_sha256(manifest_root["tasks"]),
        task_count=2,
        operation_count=2,
        manifest_count=1,
        status_distribution=Counter({"agent_done": 1, "verified_done": 1}),
    )

    report = verify_backup(chunk_roots, manifest_root, expectations)

    assert report["combined_sha256"] == expectations.combined_sha256
    assert report["manifest_sha256"] == expectations.manifest_sha256
    assert report["status_distribution"] == {
        "agent_done": 1,
        "verified_done": 1,
    }
