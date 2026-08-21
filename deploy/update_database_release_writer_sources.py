"""Refresh repository-contained Haniel writer source checksums."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "soulstream.database-release-writer-sources.v1"
DEFAULT_SOURCES_PATH = Path("deploy/database-release-writer-sources.json")


def source_sha256(repository_root: Path, source: dict[str, str]) -> str:
    path = repository_root / source["path"]
    return hashlib.sha256(path.read_bytes()).hexdigest()


def assert_source_sha256(
    repository_root: Path,
    source_name: str,
    source: dict[str, str],
) -> None:
    actual = source_sha256(repository_root, source)
    expected = source["sha256"]
    if actual != expected:
        raise AssertionError(
            "writer source checksum differs: "
            f"source={source_name} path={source['path']} "
            f"expected={expected} actual={actual}"
        )


def refresh_writer_source_checksums(
    repository_root: Path,
    sources_path: Path,
) -> bool:
    payload = _load_sources(sources_path)
    changed = False
    for source in payload["sources"].values():
        actual = source_sha256(repository_root, source)
        if source["sha256"] != actual:
            source["sha256"] = actual
            changed = True
    if changed:
        _atomic_write(
            sources_path,
            (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf8"),
        )
    return changed


def check_writer_source_checksums(
    repository_root: Path,
    sources_path: Path,
) -> None:
    payload = _load_sources(sources_path)
    for source_name, source in payload["sources"].items():
        assert_source_sha256(repository_root, source_name, source)


def _load_sources(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf8"))
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"unsupported writer sources schema: {payload.get('schema_version')}")
    sources = payload.get("sources")
    if not isinstance(sources, dict) or not sources:
        raise ValueError("writer sources must be a non-empty mapping")
    for source_name, source in sources.items():
        if not isinstance(source, dict):
            raise ValueError(f"writer source {source_name} must be a mapping")
        for field in ("path", "sha256"):
            if not isinstance(source.get(field), str) or not source[field]:
                raise ValueError(f"writer source {source_name}.{field} must be a string")
    return payload


def _atomic_write(path: Path, value: bytes) -> None:
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--repository-root", type=Path)
    parser.add_argument("--sources", type=Path)
    args = parser.parse_args()

    repository_root = (args.repository_root or Path(__file__).resolve().parents[1]).resolve()
    sources_path = (args.sources or repository_root / DEFAULT_SOURCES_PATH).resolve()
    if args.check:
        check_writer_source_checksums(repository_root, sources_path)
        return 0
    changed = refresh_writer_source_checksums(repository_root, sources_path)
    print("writer source checksums refreshed" if changed else "writer source checksums current")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
