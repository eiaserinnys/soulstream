#!/usr/bin/env python3
"""Reject direct DML against page/block projection tables in canonical SQL."""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, TextIO


SQL_ROOT = Path("packages/db-schema/sql")

EXEMPT_SQL_PATHS = frozenset(
    {
        # Immutable migration already applied in production; changing it would
        # rewrite migration history. Incident and canonical-store rationale:
        # atom nodes 7d002930-863d-46c7-8a06-2b3ecf87097d and
        # d3eb3f92-30fb-45e0-ba0f-00569eb50151.
        "packages/db-schema/sql/migrations/042_runbook_to_task.sql",
    }
)

CANONICAL_RATIONALE = (
    "`blocks`/`pages`는 투영이다. SQL로 고치면 페이지를 여는 순간 "
    "Y.Doc 정본이 덮어쓴다."
)
CANONICAL_REMEDY = (
    "데이터 정리는 `POST /api/page-yjs/host/batch-page-operations`를 호출하는 "
    "스크립트로 수행하고, 검증은 `get-page`로 라이브 문서를 재조회한다."
)
ATOM_NODES = (
    "7d002930-863d-46c7-8a06-2b3ecf87097d",
    "d3eb3f92-30fb-45e0-ba0f-00569eb50151",
)

_DOLLAR_QUOTE_START = re.compile(r"\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$")
_DML_TARGET = re.compile(
    r"""
    (?P<verb>INSERT\s+INTO|UPDATE|DELETE\s+FROM)
    \s+(?:ONLY\s+)?
    (?:
        (?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)
        \s*\.\s*
    )?
    (?P<table>"blocks"|"pages"|blocks|pages)
    (?=\s|;|\(|$)
    """,
    re.IGNORECASE | re.VERBOSE,
)


@dataclass(frozen=True)
class ProjectionDmlViolation:
    path: str
    line: int
    verb: str
    table: str
    statement: str


def _blank(masked: list[str], start: int, end: int) -> None:
    for index in range(start, end):
        if masked[index] not in "\r\n":
            masked[index] = " "


def _is_escape_string(sql: str, quote_index: int) -> bool:
    if quote_index == 0 or sql[quote_index - 1] not in "Ee":
        return False
    prefix_index = quote_index - 1
    return prefix_index == 0 or not (
        sql[prefix_index - 1].isalnum() or sql[prefix_index - 1] in "_$"
    )


def _mask_comments_and_literals(sql: str) -> str:
    """Blank comments and string literals while preserving offsets and lines."""

    masked = list(sql)
    length = len(sql)
    index = 0

    while index < length:
        if sql.startswith("--", index):
            end = sql.find("\n", index + 2)
            if end == -1:
                end = length
            _blank(masked, index, end)
            index = end
            continue

        if sql.startswith("/*", index):
            start = index
            index += 2
            depth = 1
            while index < length and depth:
                if sql.startswith("/*", index):
                    depth += 1
                    index += 2
                elif sql.startswith("*/", index):
                    depth -= 1
                    index += 2
                else:
                    index += 1
            _blank(masked, start, index)
            continue

        if sql[index] == "'":
            start = index
            uses_backslash_escapes = _is_escape_string(sql, index)
            index += 1
            while index < length:
                if (
                    uses_backslash_escapes
                    and sql[index] == "\\"
                    and index + 1 < length
                ):
                    index += 2
                elif sql[index] == "'" and index + 1 < length and sql[index + 1] == "'":
                    index += 2
                elif sql[index] == "'":
                    index += 1
                    break
                else:
                    index += 1
            _blank(masked, start, index)
            continue

        if sql[index] == "$":
            delimiter_match = _DOLLAR_QUOTE_START.match(sql, index)
            if delimiter_match:
                start = index
                delimiter = delimiter_match.group(0)
                closing = sql.find(delimiter, delimiter_match.end())
                index = length if closing == -1 else closing + len(delimiter)
                _blank(masked, start, index)
                continue

        index += 1

    return "".join(masked)


def _statement_ranges(masked_sql: str) -> Iterable[tuple[int, int]]:
    start = 0
    for index, character in enumerate(masked_sql):
        if character == ";":
            yield start, index + 1
            start = index + 1
    if masked_sql[start:].strip():
        yield start, len(masked_sql)


def _compact_statement(statement: str) -> str:
    return " ".join(statement.strip().split())


def find_projection_dml(sql: str, path: str) -> list[ProjectionDmlViolation]:
    masked_sql = _mask_comments_and_literals(sql)
    violations: list[ProjectionDmlViolation] = []

    for start, end in _statement_ranges(masked_sql):
        masked_statement = masked_sql[start:end]
        original_statement = _compact_statement(sql[start:end])
        for match in _DML_TARGET.finditer(masked_statement):
            absolute_offset = start + match.start()
            table = match.group("table").strip('"').lower()
            violations.append(
                ProjectionDmlViolation(
                    path=path,
                    line=sql.count("\n", 0, absolute_offset) + 1,
                    verb=" ".join(match.group("verb").upper().split()),
                    table=table,
                    statement=original_statement,
                )
            )

    return violations


def scan_sql_tree(repo_root: Path) -> list[ProjectionDmlViolation]:
    sql_root = repo_root / SQL_ROOT
    violations: list[ProjectionDmlViolation] = []

    for sql_path in sorted(sql_root.rglob("*.sql")):
        relative_path = sql_path.relative_to(repo_root).as_posix()
        if relative_path in EXEMPT_SQL_PATHS:
            continue
        violations.extend(
            find_projection_dml(
                sql_path.read_text(encoding="utf-8"),
                relative_path,
            )
        )

    return violations


def format_failure(violations: Iterable[ProjectionDmlViolation]) -> str:
    violations = list(violations)
    lines = ["Projection DML guard failed:"]
    for violation in violations:
        lines.append(
            f"- {violation.path}:{violation.line}: "
            f"{violation.verb} {violation.table}: {violation.statement}"
        )
    lines.extend(
        [
            CANONICAL_RATIONALE,
            f"올바른 방법: {CANONICAL_REMEDY}",
            f"atom nodes: {', '.join(ATOM_NODES)}",
        ]
    )
    return "\n".join(lines)


def run_guard(
    repo_root: Path,
    *,
    stdout: TextIO = sys.stdout,
    stderr: TextIO = sys.stderr,
) -> int:
    violations = scan_sql_tree(repo_root)
    if violations:
        print(format_failure(violations), file=stderr)
        return 1
    print("Projection DML guard passed.", file=stdout)
    return 0


def main() -> int:
    return run_guard(Path(__file__).resolve().parents[3])


if __name__ == "__main__":
    raise SystemExit(main())
