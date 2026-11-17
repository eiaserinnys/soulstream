"""Contracts for migration-to-schema function drift detection."""
import importlib.util
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_function_drift.py"
spec = importlib.util.spec_from_file_location("check_function_drift", SCRIPT)
drift = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drift)


def test_split_statements_handles_quotes_comments_and_dollar_bodies():
    sql = """-- first; comment
CREATE FUNCTION f() RETURNS text AS $body$ BEGIN RETURN 'a;''b'; END $body$ LANGUAGE plpgsql;
/* comment; */ DROP FUNCTION f(); -- end;
"""
    statements = drift.function_statements(sql)
    assert len(statements) == 2
    assert "RETURN 'a;''b'" in statements[0]
    assert statements[1].startswith("DROP FUNCTION f()")


def test_latest_definitions_track_signatures_drop_and_rename():
    migrations = ["""CREATE FUNCTION f(p_value text) RETURNS text AS $$ SELECT p_value $$ LANGUAGE sql;
CREATE FUNCTION f(p_value integer) RETURNS integer AS $$ SELECT p_value $$ LANGUAGE sql;
ALTER FUNCTION f(text) RENAME TO renamed;
DROP FUNCTION f(integer);
"""]
    result = drift.latest_functions(migrations)
    assert set(result) == {("renamed", ("text",))}
    assert "FUNCTION renamed(" in next(iter(result.values()))


@pytest.mark.asyncio
async def test_current_schema_matches_latest_migrations(test_database_url):
    assert await drift.check_drift(test_database_url, drift.SCHEMA_PATH.read_text()) == []


@pytest.mark.asyncio
async def test_changed_body_reports_function(test_database_url):
    sql = drift.SCHEMA_PATH.read_text().replace("RETURN 'not_pending';", "RETURN 'not_pending_x';", 1)
    differences = await drift.check_drift(test_database_url, sql)
    assert any("session_acknowledge_review" in item for item in differences)


@pytest.mark.asyncio
async def test_duplicate_function_definition_is_rejected(test_database_url):
    sql = drift.SCHEMA_PATH.read_text()
    definition = next(s for s in drift.function_statements(sql) if "FUNCTION session_acknowledge_review(" in s)
    differences = await drift.check_drift(test_database_url, sql + "\n" + definition)
    assert any("duplicate" in item.lower() and "session_acknowledge_review" in item for item in differences)


def test_final_drops_and_renames_remove_old_signatures():
    migrations = ["""CREATE FUNCTION f(p_value text) RETURNS text AS $$ SELECT p_value $$ LANGUAGE sql;
ALTER FUNCTION f(text) RENAME TO renamed;
DROP FUNCTION IF EXISTS obsolete(integer);
"""]
    definitions, removed = drift.migration_effects(migrations)
    assert ("renamed", ("text",)) in definitions
    assert removed == {("f", ("text",)), ("obsolete", ("integer",))}
