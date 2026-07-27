"""Contract tests for projection-table DML in canonical SQL files."""

from __future__ import annotations

import sys
import tempfile
import unittest
from io import StringIO
from pathlib import Path


PACKAGE_DIR = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = PACKAGE_DIR / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from check_projection_dml import (  # noqa: E402
    EXEMPT_SQL_PATHS,
    find_projection_dml,
    format_failure,
    run_guard,
    scan_sql_tree,
)


FORBIDDEN_CASES = (
    ("plain UPDATE", "UPDATE blocks SET block_type = 'task_ref';", ("blocks",)),
    (
        "schema-qualified",
        "UPDATE public.pages SET title = 'renamed';",
        ("pages",),
    ),
    (
        "quoted ident",
        'UPDATE "public"."blocks" SET block_type = \'task_ref\';',
        ("blocks",),
    ),
    (
        "CTE + UPDATE",
        "WITH target AS (SELECT id FROM blocks) "
        "UPDATE pages SET title = 'renamed' WHERE id IN (SELECT id FROM target);",
        ("pages",),
    ),
    (
        "INSERT SELECT",
        "INSERT INTO blocks (id) SELECT id FROM archived_blocks;",
        ("blocks",),
    ),
    (
        "DELETE ONLY",
        "DELETE FROM ONLY pages WHERE archived = TRUE;",
        ("pages",),
    ),
    (
        "INSERT ... ON CONFLICT",
        "INSERT INTO blocks (id) VALUES ('block-1') "
        "ON CONFLICT (id) DO UPDATE SET updated_at = NOW();",
        ("blocks",),
    ),
    (
        "DO block",
        """
        DO $$
        BEGIN
          UPDATE blocks SET block_type = 'task_ref';
        END
        $$;
        """,
        ("blocks",),
    ),
    (
        "CREATE FUNCTION body",
        """
        CREATE FUNCTION rewrite_pages() RETURNS void AS $body$
        BEGIN
          DELETE FROM pages WHERE archived = TRUE;
        END
        $body$ LANGUAGE plpgsql;
        """,
        ("pages",),
    ),
    (
        "MERGE INTO",
        "MERGE INTO blocks AS target USING staged_blocks AS source "
        "ON target.id = source.id WHEN MATCHED THEN DELETE;",
        ("blocks",),
    ),
    (
        "TRUNCATE",
        "TRUNCATE blocks; "
        "TRUNCATE TABLE ONLY blocks CASCADE; "
        "TRUNCATE audit_log, public.pages;",
        ("blocks", "blocks", "pages"),
    ),
    (
        "COPY ... FROM",
        "COPY blocks (id, block_type) FROM '/tmp/blocks.csv' WITH (FORMAT csv);",
        ("blocks",),
    ),
)

SAFE_CASES = (
    (
        "safe DDL",
        "CREATE TABLE blocks (id UUID PRIMARY KEY); "
        "ALTER TABLE pages ADD COLUMN archived BOOLEAN; "
        "CREATE INDEX idx_blocks_id ON blocks (id);",
    ),
    ("safe SELECT", "SELECT * FROM pages JOIN blocks USING (page_id);"),
    ("COPY ... TO", "COPY pages TO STDOUT WITH (FORMAT csv);"),
    (
        "single-quoted data literal",
        "SELECT 'UPDATE blocks; MERGE INTO pages; TRUNCATE blocks;';",
    ),
    (
        "escape-string data literal",
        r"SELECT E'COPY blocks FROM \'/tmp/file\'';",
    ),
    (
        "comments",
        "-- UPDATE blocks SET title = 'ignored';\n"
        "/* DELETE FROM pages; /* nested TRUNCATE blocks; */ */ SELECT 1;",
    ),
)


class ProjectionDmlGuardTest(unittest.TestCase):
    def test_pattern_inventory_covers_the_review_matrix(self) -> None:
        self.assertEqual(
            tuple(name for name, _sql, _tables in FORBIDDEN_CASES),
            (
                "plain UPDATE",
                "schema-qualified",
                "quoted ident",
                "CTE + UPDATE",
                "INSERT SELECT",
                "DELETE ONLY",
                "INSERT ... ON CONFLICT",
                "DO block",
                "CREATE FUNCTION body",
                "MERGE INTO",
                "TRUNCATE",
                "COPY ... FROM",
            ),
        )
        self.assertEqual(
            tuple(name for name, _sql in SAFE_CASES),
            (
                "safe DDL",
                "safe SELECT",
                "COPY ... TO",
                "single-quoted data literal",
                "escape-string data literal",
                "comments",
            ),
        )

    def test_forbidden_patterns_are_detected(self) -> None:
        for name, sql, expected_tables in FORBIDDEN_CASES:
            with self.subTest(name=name):
                violations = find_projection_dml(sql, f"fixtures/{name}.sql")

                self.assertEqual(
                    tuple(violation.table for violation in violations),
                    expected_tables,
                )

    def test_safe_patterns_do_not_trigger(self) -> None:
        for name, sql in SAFE_CASES:
            with self.subTest(name=name):
                self.assertEqual(find_projection_dml(sql, f"fixtures/{name}.sql"), [])

    def test_failure_reports_file_line_statement_and_remediation(self) -> None:
        sql = "\nUPDATE blocks SET block_type = 'task_ref';"
        violations = find_projection_dml(sql, "fixtures/forbidden.sql")
        message = format_failure(violations)
        self.assertIn("fixtures/forbidden.sql:2", message)
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

    def test_forbidden_sql_makes_the_guard_fail(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            sql_path = repo_root / "packages" / "db-schema" / "sql" / "schema.sql"
            sql_path.parent.mkdir(parents=True)
            sql_path.write_text(FORBIDDEN_CASES[0][1], encoding="utf-8")
            stderr = StringIO()

            exit_code = run_guard(repo_root, stdout=StringIO(), stderr=stderr)

        self.assertEqual(exit_code, 1)
        self.assertIn("packages/db-schema/sql/schema.sql:1", stderr.getvalue())
        self.assertIn("Projection DML guard failed", stderr.getvalue())

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

    def test_dollar_quoted_data_is_checked_conservatively(self) -> None:
        sql = "SELECT $$UPDATE blocks SET block_type = 'task_ref'$$;"

        violations = find_projection_dml(sql, "fixtures/dollar-data.sql")

        self.assertEqual(
            [(violation.verb, violation.table) for violation in violations],
            [("UPDATE", "blocks")],
        )

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
