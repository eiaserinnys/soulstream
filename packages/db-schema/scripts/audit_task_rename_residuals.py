#!/usr/bin/env python3
"""Reject every undeclared ``runbook`` residual in the repository."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
SELF = "packages/db-schema/scripts/audit_task_rename_residuals.py"

ALLOWLIST = {
    # Immutable history and captured evidence.
    "orch-server/DEPRECATED.md": "deprecated Python engine history",
    "packages/db-schema/sql/migrations/027_board_runbooks.sql": "immutable historical migration",
    "packages/db-schema/sql/migrations/029_runbook_status.sql": "immutable historical migration",
    "packages/db-schema/sql/migrations/031_runbook_item_review_status.sql": "immutable historical migration",
    "packages/db-schema/sql/migrations/032_board_items_container.sql": "immutable historical migration",
    "packages/db-schema/sql/migrations/033_board_seed_primary_membership_guard.sql": "immutable historical migration",
    "packages/db-schema/sql/migrations/037_session_page_bindings.sql": "immutable historical migration",
    "packages/db-schema/sql/migrations/039_checklist_runbook_projection_outbox.sql": "immutable historical migration",
    "unified-dashboard/e2e/evidence/pr-ch-post-deploy-defects/after/metrics.json": "immutable E2E evidence",
    "unified-dashboard/e2e/evidence/pr-ch-post-deploy-defects/before/metrics.json": "immutable E2E evidence",
    "unified-dashboard/e2e/evidence/pr-ci-fetch-races/metrics.json": "immutable E2E evidence",

    # 041 -> 042 transition, verifier, and compatibility views.
    SELF: "the executable allowlist itself",
    "packages/db-schema/scripts/verify_runbook_to_task_migration.py": "source-to-target migration verifier",
    "packages/db-schema/sql/migrations/042_runbook_to_task.sql": "one-time schema migration and read views",
    "packages/db-schema/sql/schema.sql": "legacy-to-canonical transition and one-release read views",
    "packages/db-schema/tests/test_db_procedures.py": "immutable historical migration filename assertions",
    "packages/db-schema/tests/test_runbook_to_task_migration.py": "isolated source-to-target migration proof",
    "packages/db-schema/tests/test_verify_runbook_to_task_migration.py": "verifier vocabulary normalization tests",

    # One-release public read compatibility. No producer or mutation is allowed.
    "orch-server-ts/src/runtime/node_session_event_dispatcher.ts": "legacy wire consumer normalization",
    "orch-server-ts/src/tasks/task_legacy_http_compat.ts": "declared legacy HTTP reads and 410 writes",
    "orch-server-ts/tests/node-session-event-dispatcher.test.ts": "legacy wire consumer test",
    "orch-server-ts/tests/task-contract-rename.test.ts": "public contract residual assertion",
    "orch-server-ts/tests/task-routes.test.ts": "legacy HTTP compatibility test",
    "packages/soul-ui/src/hooks/session-stream-dispatch.test.ts": "legacy wire consumer test",
    "packages/soul-ui/src/hooks/session-stream-dispatch.ts": "legacy wire consumer normalization",
    "packages/soul-ui/src/hooks/useSessionStreamSSE.ts": "legacy SSE listener for one release",
    "packages/soul-ui/src/shared/constants.ts": "legacy SSE listener registration",
    "packages/soul-ui/src/shared/sse-events.ts": "legacy wire consumer type",
    "packages/soul-ui/src/shared/stream-events.ts": "legacy wire consumer type",
    "packages/wire-schema/generated/python/upstream.py": "generated legacy read union",
    "packages/wire-schema/generated/typescript/index.ts": "generated legacy read union",
    "packages/wire-schema/src/README.md": "documented one-release legacy read count",
    "packages/wire-schema/src/upstream.schema.json": "legacy wire consumer schema",
    "packages/wire-schema/tests/test_schema_valid.py": "legacy wire consumer inventory test",
    "soul-server-ts/src/mcp/tools/task_legacy_read_compat.ts": "three declared legacy MCP reads",
    "soul-server-ts/src/supervisor/wake_classification.ts": "legacy wire consumer classification",
    "soul-server-ts/src/work-task/task_legacy_http_compat.ts": "explicit 410 for legacy worker writes",
    "soul-server-ts/tests/mcp/task.test.ts": "legacy MCP compatibility test",
    "soul-server-ts/tests/work-task/task_http_route.test.ts": "legacy HTTP 410 test",

    # One-release persisted container/Y.Doc readers; every write is canonical Task.
    "orch-server-ts/src/board-yjs/board_container_kind_compat.ts": "legacy container reader",
    "orch-server-ts/src/board-yjs/board_yjs_document.ts": "legacy Y.Doc name and item reader",
    "orch-server-ts/src/board-yjs/board_yjs_host_operations.ts": "legacy host payload reader",
    "orch-server-ts/tests/board-yjs-model-parity.test.ts": "legacy Y.Doc reader test",
    "soul-server-ts/src/collaboration/board_container_kind_compat.ts": "legacy container reader",
    "soul-server-ts/src/collaboration/board_yjs_host_route.ts": "legacy host payload reader",
    "soul-server-ts/src/collaboration/board_yjs_model.ts": "legacy Y.Doc item reader",
    "soul-server-ts/tests/collaboration/board_yjs_model.test.ts": "legacy Y.Doc reader test",
}


def _tracked_and_untracked_files() -> list[str]:
    output = subprocess.check_output(
        [
            "git",
            "-C",
            str(REPOSITORY_ROOT),
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
        text=True,
    )
    return sorted(filter(None, output.splitlines()))


def find_residuals() -> dict[str, list[int]]:
    residuals: dict[str, list[int]] = {}
    for relative_path in _tracked_and_untracked_files():
        path = REPOSITORY_ROOT / relative_path
        if not path.is_file():
            continue
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (UnicodeDecodeError, OSError):
            continue
        matches = [
            line_number
            for line_number, line in enumerate(lines, start=1)
            if "runbook" in line.casefold()
        ]
        if matches:
            residuals[relative_path] = matches
    return residuals


def main() -> int:
    residuals = find_residuals()
    unexpected = sorted(set(residuals) - set(ALLOWLIST))
    report = {
        "status": "error" if unexpected else "ok",
        "residual_file_count": len(residuals),
        "unexpected": unexpected,
        "allowed": {
            path: {"reason": ALLOWLIST[path], "lines": residuals[path]}
            for path in sorted(residuals)
            if path in ALLOWLIST
        },
    }
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 1 if unexpected else 0


if __name__ == "__main__":
    raise SystemExit(main())
