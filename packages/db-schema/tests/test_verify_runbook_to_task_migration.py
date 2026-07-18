"""Unit tests for the 042 data-preservation verifier."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from verify_runbook_to_task_migration import (  # noqa: E402
    VerificationError,
    canonical_sha256,
    compare_snapshots,
    normalize_row,
)
from audit_task_rename_residuals import (  # noqa: E402
    ALLOWLIST,
    find_residuals,
    validate_read_compatibility_gate,
)


def test_normalization_changes_contract_vocabulary_only() -> None:
    legacy = normalize_row(
        "board_items",
        {
            "id": "runbook:opaque-id",
            "item_type": "runbook",
            "container_kind": "runbook",
            "source_runbook_item_id": "item-1",
            "metadata": {"title": "runbook stays in user content"},
        },
    )
    canonical = normalize_row(
        "board_items",
        {
            "id": "runbook:opaque-id",
            "item_type": "task",
            "container_kind": "task",
            "source_task_item_id": "item-1",
            "metadata": {"title": "runbook stays in user content"},
        },
    )

    assert legacy == canonical
    assert legacy["id"] == "runbook:opaque-id"
    assert legacy["metadata"]["title"] == "runbook stays in user content"


def test_normalization_handles_cached_wire_shape() -> None:
    legacy = normalize_row(
        "catalog_cache",
        {
            "container_kind": "runbook",
            "board_items": [
                {
                    "itemType": "runbook",
                    "containerKind": "runbook",
                    "sourceRunbookItemId": "item-1",
                    "runbookId": "work-1",
                }
            ],
        },
    )
    canonical = normalize_row(
        "catalog_cache",
        {
            "container_kind": "task",
            "board_items": [
                {
                    "itemType": "task",
                    "containerKind": "task",
                    "sourceTaskItemId": "item-1",
                    "taskId": "work-1",
                }
            ],
        },
    )

    assert legacy == canonical


def test_snapshot_comparison_reports_the_changed_relation() -> None:
    before = {
        "schema": "work-task-migration-snapshot.v1",
        "summary": {"counts": {"work": 1}},
        "rows": {"work": [{"id": "work-1", "title": "보존"}]},
    }
    after = {
        "schema": "work-task-migration-snapshot.v1",
        "summary": {"counts": {"work": 1}},
        "rows": {"work": [{"id": "work-1", "title": "손실"}]},
    }

    with pytest.raises(VerificationError, match="work"):
        compare_snapshots(before, after)

    assert canonical_sha256(before) != canonical_sha256(after)


def test_task_rename_residuals_are_explicitly_allowlisted() -> None:
    residuals = find_residuals()

    assert sorted(set(residuals) - set(ALLOWLIST)) == []


def test_read_compatibility_removal_requires_production_evidence() -> None:
    assert validate_read_compatibility_gate() == []
