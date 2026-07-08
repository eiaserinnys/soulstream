"""DB function contract snapshot for orch TS/Python implementations."""

from __future__ import annotations

import re
from pathlib import Path

from tests.orch_contract_helpers import load_contract_fixture


SCHEMA_PATH = (
    Path(__file__).parents[2] / "packages" / "db-schema" / "sql" / "schema.sql"
)


def _normalize_sql(value: str) -> str:
    return " ".join(value.split())


def _function_signature(schema: str, name: str) -> tuple[str, str]:
    pattern = re.compile(
        rf"CREATE OR REPLACE FUNCTION\s+{re.escape(name)}\s*"
        r"\((.*?)\)\s+RETURNS\s+(.+?)\s+(?:LANGUAGE|AS\s+\$\$)",
        re.IGNORECASE | re.DOTALL,
    )
    match = pattern.search(schema)
    assert match is not None, f"Missing function {name}"
    return _normalize_sql(match.group(1)), _normalize_sql(match.group(2))


def test_schema_sql_function_contract_snapshot():
    fixture = load_contract_fixture("db_function_contract.json")
    schema = SCHEMA_PATH.read_text(encoding="utf-8")

    for expected in fixture["functions"]:
        args, returns = _function_signature(schema, expected["name"])
        assert args == expected["args"]
        if "returns" in expected:
            assert returns == expected["returns"]
        else:
            for token in expected["returnsContains"]:
                assert token in returns
