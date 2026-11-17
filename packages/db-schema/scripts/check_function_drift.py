"""Compare fresh-schema functions with the last definitions in migration order."""
from __future__ import annotations

import argparse
import asyncio
from collections import Counter
import json
from pathlib import Path
import re
import uuid
from urllib.parse import urlparse

import asyncpg

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "sql" / "schema.sql"
MIGRATIONS = ROOT / "sql" / "migrations"
MANIFEST = ROOT / "migration-manifest.json"
FUNCTION = re.compile(
    r"^(CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION|DROP\s+FUNCTION(?:\s+IF\s+EXISTS)?|ALTER\s+FUNCTION)\s+([\w.\"]+)\s*\(",
    re.IGNORECASE,
)
DOLLAR = re.compile(r"\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$")


def split_statements(sql: str) -> list[str]:
    statements = []
    start = i = 0
    while i < len(sql):
        if sql.startswith("--", i):
            end = sql.find("\n", i)
            i = len(sql) if end < 0 else end + 1
        elif sql.startswith("/*", i):
            end = sql.find("*/", i + 2)
            i = len(sql) if end < 0 else end + 2
        elif sql[i] in "'\"":
            quote = sql[i]
            i += 1
            while i < len(sql):
                if sql[i] == quote:
                    i += 1
                    if i < len(sql) and sql[i] == quote:
                        i += 1
                    else:
                        break
                else:
                    i += 1
        elif sql[i] == "$" and (match := DOLLAR.match(sql, i)):
            end = sql.find(match.group(), match.end())
            i = len(sql) if end < 0 else end + len(match.group())
        elif sql[i] == ";":
            statements.append(sql[start:i + 1])
            i += 1
            start = i
        else:
            i += 1
    if sql[start:].strip():
        statements.append(sql[start:])
    return statements


def function_statements(sql: str) -> list[str]:
    result = []
    for statement in split_statements(sql):
        statement = re.sub(r"\A(?:\s|--[^\n]*(?:\n|$)|/\*.*?\*/)*", "", statement, flags=re.S)
        if FUNCTION.match(statement):
            result.append(statement)
    return result


def signature(statement: str):
    match = FUNCTION.match(statement)
    if match is None:
        raise ValueError("Not a function statement")
    depth, end = 1, match.end()
    while depth:
        if statement[end] == "(":
            depth += 1
        elif statement[end] == ")":
            depth -= 1
        end += 1
    raw_args = statement[match.end():end - 1]
    args = []
    for arg in re.split(r",\s*(?![^()]*\))", raw_args):
        arg = re.split(r"\s+(?:DEFAULT|=)\s*", arg.strip(), maxsplit=1, flags=re.I)[0]
        words = arg.lower().split()
        if not words:
            continue
        if words[0] in ("in", "inout", "variadic"):
            words.pop(0)
        # CREATE declarations have parameter names; DROP/ALTER normally have types only.
        if match.group(1).upper().startswith("CREATE") and len(words) > 1 and words[0] not in ("double", "character", "timestamp", "time"):
            words.pop(0)
        arg_type = " ".join(words)
        arg_type = {"timestamptz": "timestamp with time zone", "int": "integer", "int4": "integer", "bool": "boolean", "varchar": "character varying"}.get(arg_type, arg_type)
        args.append(arg_type)
    return match.group(1).upper(), match.group(2).lower().removeprefix("public."), tuple(args), end


def migration_effects(migrations: list[str]) -> tuple[dict, set]:
    latest = {}
    removed = set()
    for sql in migrations:
        for statement in function_statements(sql):
            kind, name, args, end = signature(statement)
            key = (name, args)
            if kind.startswith("CREATE"):
                latest[key] = statement
                removed.discard(key)
            elif kind.startswith("DROP"):
                latest.pop(key, None)
                removed.add(key)
            else:
                rename = re.match(r"\s*RENAME\s+TO\s+([\w\"]+)", statement[end:], re.I)
                if rename and key in latest:
                    new_name = rename.group(1).lower()
                    definition = latest.pop(key)
                    removed.add(key)
                    removed.discard((new_name, args))
                    latest[(new_name, args)] = re.sub(
                        r"(FUNCTION\s+)[\w.\"]+(\s*\()", rf"\g<1>{new_name}\2", definition, count=1, flags=re.I
                    )
    return latest, removed


def latest_functions(migrations: list[str]) -> dict:
    return migration_effects(migrations)[0]


def normalize(definition: str) -> str:
    # Keep quoted strings intact while discarding SQL comments and formatting.
    parts = re.split(r"('(?:''|[^'])*')", definition)
    for index in range(0, len(parts), 2):
        part = re.sub(r"--[^\n]*|/\*.*?\*/", " ", parts[index], flags=re.S)
        parts[index] = re.sub(r"\s+", " ", part)
    return "".join(parts).strip()


async def definitions(conn, schema: str) -> dict[str, str]:
    await conn.execute(f'SET search_path TO "{schema}"')
    rows = await conn.fetch("""
        SELECT p.oid::regprocedure::text AS signature, pg_get_functiondef(p.oid) AS definition
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND p.prokind = 'f'
    """, schema)
    return {
        row["signature"]: normalize(row["definition"].replace(f"FUNCTION {schema}.", "FUNCTION ", 1))
        for row in rows
    }


async def check_drift(database_url: str, schema_sql: str) -> list[str]:
    database_name = urlparse(database_url).path.lstrip("/").lower()
    if "test" not in database_name or any(token in database_name for token in (
        "atom_db", "reverie", "soulstream_db", "soul_dashboard_db", "serendipity"
    )):
        raise ValueError("database URL must point to an isolated test database")
    counts = Counter((name, args) for kind, name, args, _ in map(signature, function_statements(schema_sql)) if kind.startswith("CREATE"))
    duplicates = [f"duplicate function: {name}({', '.join(args)})" for (name, args), count in counts.items() if count > 1]
    if duplicates:
        return sorted(duplicates)
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    migrations = [(MIGRATIONS / entry["id"]).read_text(encoding="utf-8") for entry in manifest["migrations"]]
    latest, removed = migration_effects(migrations)
    conn = await asyncpg.connect(database_url)
    names = [f"drift_{uuid.uuid4().hex}", f"drift_{uuid.uuid4().hex}"]
    try:
        for name in names:
            await conn.execute(f'CREATE SCHEMA "{name}"')
            await conn.execute(f'SET search_path TO "{name}"')
            await conn.execute(schema_sql)
        before = await definitions(conn, names[0])
        await conn.execute(f'SET search_path TO "{names[1]}"')
        for name, arguments in sorted(removed):
            await conn.execute(f'DROP FUNCTION IF EXISTS "{name}"({", ".join(arguments)})')
        for statement in latest.values():
            await conn.execute(statement)
        after = await definitions(conn, names[1])
        return [f"function differs: {key}" for key in sorted(before.keys() | after.keys()) if before.get(key) != after.get(key)]
    finally:
        await conn.execute('SET search_path TO public')
        for name in names:
            await conn.execute(f'DROP SCHEMA IF EXISTS "{name}" CASCADE')
        await conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-url", required=True)
    parser.add_argument("--schema", type=Path, default=SCHEMA_PATH)
    args = parser.parse_args()
    differences = asyncio.run(check_drift(args.database_url, args.schema.read_text(encoding="utf-8")))
    if differences:
        print("\n".join(differences))
        return 1
    print("Schema functions match the latest migration definitions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
