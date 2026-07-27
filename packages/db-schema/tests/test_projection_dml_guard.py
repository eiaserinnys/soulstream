"""Contract tests for projection-table DML in canonical SQL files."""

from __future__ import annotations

import sys
import tempfile
import unittest
from io import StringIO
from pathlib import Path


PACKAGE_DIR = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = PACKAGE_DIR / "scripts"
FIXTURES_DIR = Path(__file__).parent / "fixtures" / "projection_dml_guard"
sys.path.insert(0, str(SCRIPTS_DIR))

from check_projection_dml import (  # noqa: E402
    EXEMPT_SQL_PATHS,
    find_projection_dml,
    format_failure,
    run_guard,
    scan_sql_tree,
)


class ProjectionDmlGuardTest(unittest.TestCase):
    def test_forbidden_fixture_reports_file_line_and_statement(self) -> None:
        sql = (FIXTURES_DIR / "forbidden.sql").read_text(encoding="utf-8")

        violations = find_projection_dml(sql, "fixtures/forbidden.sql")

        self.assertEqual(
            [(violation.table, violation.line) for violation in violations],
            [("blocks", 3), ("pages", 6), ("blocks", 8)],
        )
        message = format_failure(violations)
        self.assertIn("fixtures/forbidden.sql:3", message)
        self.assertIn("UPDATE blocks SET block_type = 'task_ref';", message)
        self.assertIn(
            "`blocks`/`pages`는 투영이다. SQL로 고치면 페이지를 여는 순간 "
            "Y.Doc 정본이 덮어쓴다.",
            message,
        )
        self.assertIn(
            "POST /api/page-yjs/host/batch-page-operations",
            message,
        )
        self.assertIn("get-page", message)
        self.assertIn("7d002930-863d-46c7-8a06-2b3ecf87097d", message)
        self.assertIn("d3eb3f92-30fb-45e0-ba0f-00569eb50151", message)

    def test_forbidden_fixture_makes_the_guard_fail(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            sql_path = repo_root / "packages" / "db-schema" / "sql" / "schema.sql"
            sql_path.parent.mkdir(parents=True)
            sql_path.write_text(
                (FIXTURES_DIR / "forbidden.sql").read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            stderr = StringIO()

            exit_code = run_guard(repo_root, stdout=StringIO(), stderr=stderr)

        self.assertEqual(exit_code, 1)
        self.assertIn("packages/db-schema/sql/schema.sql:3", stderr.getvalue())
        self.assertIn("Projection DML guard failed", stderr.getvalue())

    def test_safe_fixture_allows_ddl_select_comments_and_literals(self) -> None:
        sql = (FIXTURES_DIR / "safe.sql").read_text(encoding="utf-8")

        self.assertEqual(find_projection_dml(sql, "fixtures/safe.sql"), [])

    def test_standard_string_backslash_does_not_hide_the_next_statement(self) -> None:
        sql = "SELECT '\\';\nUPDATE pages SET archived = TRUE;"

        violations = find_projection_dml(sql, "fixtures/backslash.sql")

        self.assertEqual(
            [(violation.table, violation.line) for violation in violations],
            [("pages", 2)],
        )

    def test_escape_string_with_quoted_dml_text_is_ignored(self) -> None:
        sql = r"SELECT E'UPDATE blocks SET text = \'quoted\'';"

        self.assertEqual(find_projection_dml(sql, "fixtures/escape.sql"), [])

    def test_exception_inventory_is_frozen_to_the_historical_migration(self) -> None:
        self.assertEqual(
            EXEMPT_SQL_PATHS,
            frozenset(
                {
                    "packages/db-schema/sql/migrations/042_runbook_to_task.sql",
                }
            ),
        )

    def test_repository_sql_has_no_unapproved_projection_dml(self) -> None:
        self.assertEqual(scan_sql_tree(PACKAGE_DIR.parents[1]), [])


if __name__ == "__main__":
    unittest.main()
