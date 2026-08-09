"""Generate and verify a secret-free Haniel writer-graph projection.

The node-local Haniel YAML remains the deployment source of truth.  This
module records its byte checksum and only the repository/dependency graph
needed by ``ServiceRunner.get_affected_services``.  It never serializes run
commands, paths, environment values, or credentials from the live source.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any

import yaml


PROVENANCE_SCHEMA = "soulstream.haniel-writer-provenance.v1"
SOURCE_LOCATOR = "eiaserinnys:services/haniel/haniel.yaml"
GENERATOR_PATH = "deploy/generate_haniel_writer_projection.py"


def _mapping(value: object, name: str) -> dict[str, Any]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ValueError(f"{name} must be a string-keyed mapping")
    return value


def extract_writer_graph(source: object) -> dict[str, object]:
    """Return the minimal deterministic graph used by Haniel impact analysis."""

    root = _mapping(source, "Haniel config")
    repositories = _mapping(root.get("repos", {}), "repos")
    services = _mapping(root.get("services", {}), "services")

    projected_repositories: dict[str, dict[str, str]] = {}
    for name in sorted(repositories):
        value = _mapping(repositories[name], f"repos.{name}")
        projection: dict[str, str] = {}
        for key in ("branch", "release_manifest"):
            field = value.get(key)
            if field is not None:
                if not isinstance(field, str) or not field.strip():
                    raise ValueError(f"repos.{name}.{key} must be a non-empty string")
                projection[key] = field.strip()
        projected_repositories[name] = projection

    projected_services: dict[str, dict[str, object]] = {}
    for name in sorted(services):
        value = _mapping(services[name], f"services.{name}")
        projection: dict[str, object] = {}
        repo = value.get("repo")
        if repo is not None:
            if not isinstance(repo, str) or repo not in repositories:
                raise ValueError(f"services.{name}.repo must name a configured repository")
            projection["repo"] = repo
        enabled = value.get("enabled", True)
        if not isinstance(enabled, bool):
            raise ValueError(f"services.{name}.enabled must be a boolean")
        projection["enabled"] = enabled
        after = value.get("after", [])
        if after is None:
            after = []
        if not isinstance(after, list) or not all(
            isinstance(item, str) and item in services for item in after
        ):
            raise ValueError(f"services.{name}.after must name configured services")
        projection["after"] = sorted(set(after))
        projected_services[name] = projection

    if "soulstream" not in projected_repositories:
        raise ValueError("repos.soulstream is required")
    if not any(value.get("repo") == "soulstream" for value in projected_services.values()):
        raise ValueError("at least one soulstream service is required")
    return {
        "repos": projected_repositories,
        "services": projected_services,
    }


def render_haniel_projection(graph: object) -> str:
    """Render a loader-complete YAML without copying secret-bearing values."""

    value = _mapping(graph, "writer graph")
    repositories = _mapping(value.get("repos", {}), "writer graph repos")
    services = _mapping(value.get("services", {}), "writer graph services")
    rendered_repositories: dict[str, dict[str, str]] = {}
    for name in sorted(repositories):
        source_repo = _mapping(repositories[name], f"writer graph repos.{name}")
        safe_name = "".join(character if character.isalnum() else "-" for character in name)
        rendered = {
            "url": f"https://example.invalid/{safe_name}.git",
            "branch": str(source_repo.get("branch", "main")),
            "path": f"./services/{safe_name}",
        }
        release_manifest = source_repo.get("release_manifest")
        if release_manifest is not None:
            rendered["release_manifest"] = str(release_manifest)
        rendered_repositories[name] = rendered

    rendered_services: dict[str, dict[str, object]] = {}
    for name in sorted(services):
        source_service = _mapping(services[name], f"writer graph services.{name}")
        rendered: dict[str, object] = {
            "run": "node generated-writer-projection.js",
            "cwd": ".",
        }
        enabled = source_service.get("enabled", True)
        if not isinstance(enabled, bool):
            raise ValueError(f"writer graph services.{name}.enabled must be a boolean")
        rendered["enabled"] = enabled
        if source_service.get("repo") is not None:
            rendered["repo"] = source_service["repo"]
        after = source_service.get("after", [])
        if after:
            rendered["after"] = list(after)
        rendered_services[name] = rendered

    return yaml.safe_dump(
        {"repos": rendered_repositories, "services": rendered_services},
        allow_unicode=True,
        sort_keys=True,
    )


def build_provenance(source_bytes: bytes) -> tuple[dict[str, object], bytes]:
    source = yaml.safe_load(source_bytes)
    graph = extract_writer_graph(source)
    fixture = render_haniel_projection(graph).encode("utf8")
    provenance = {
        "schema_version": PROVENANCE_SCHEMA,
        "source_locator": SOURCE_LOCATOR,
        "source_sha256": hashlib.sha256(source_bytes).hexdigest(),
        "generator": GENERATOR_PATH,
        "writer_graph": graph,
        "fixture_sha256": hashlib.sha256(fixture).hexdigest(),
    }
    return provenance, fixture


def verify_committed_projection(
    *,
    repository_root: Path,
    source: dict[str, str],
    live_source: Path | None = None,
) -> dict[str, str]:
    fixture_path = repository_root / source["path"]
    provenance_path = repository_root / source["provenance_path"]
    fixture = fixture_path.read_bytes()
    provenance = json.loads(provenance_path.read_text(encoding="utf8"))
    if provenance.get("schema_version") != PROVENANCE_SCHEMA:
        raise AssertionError("writer provenance schema differs")
    if provenance.get("generator") != GENERATOR_PATH:
        raise AssertionError("writer provenance generator differs")
    if source.get("source_sha256") != provenance.get("source_sha256"):
        raise AssertionError("writer source checksum provenance differs")
    expected_fixture = render_haniel_projection(provenance["writer_graph"]).encode("utf8")
    fixture_digest = hashlib.sha256(fixture).hexdigest()
    if fixture != expected_fixture or fixture_digest != provenance.get("fixture_sha256"):
        raise AssertionError("committed writer fixture is not the deterministic projection")
    if fixture_digest != source.get("sha256"):
        raise AssertionError("writer fixture checksum differs")

    live_state = "not_requested"
    if live_source is not None:
        live_bytes = live_source.read_bytes()
        live_provenance, live_fixture = build_provenance(live_bytes)
        if live_provenance != provenance or live_fixture != fixture:
            raise AssertionError("live Haniel writer graph differs from committed provenance")
        live_state = "verified"
    return {"fixture": "verified", "live_source": live_state}


def _atomic_write(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def generate(source_path: Path, fixture_path: Path, provenance_path: Path) -> None:
    provenance, fixture = build_provenance(source_path.read_bytes())
    _atomic_write(fixture_path, fixture)
    _atomic_write(
        provenance_path,
        (json.dumps(provenance, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
        .encode("utf8"),
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--provenance", type=Path, required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        source_bytes = args.source.read_bytes()
        provenance, fixture = build_provenance(source_bytes)
        if args.fixture.read_bytes() != fixture:
            raise SystemExit("HANIEL_WRITER_SOURCE_DRIFT: fixture differs")
        if json.loads(args.provenance.read_text(encoding="utf8")) != provenance:
            raise SystemExit("HANIEL_WRITER_SOURCE_DRIFT: provenance differs")
        return 0
    generate(args.source, args.fixture, args.provenance)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
