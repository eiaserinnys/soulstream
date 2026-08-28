"""Stable CI prerequisite oracle shared by strict and mutation tests."""

from __future__ import annotations

import copy
import importlib.metadata
import json
from pathlib import Path
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
CONTRACT_PATH = Path(__file__).parent / "fixtures" / "ci_prerequisite_contract.json"
CENTRAL_MANIFEST_PATH = REPOSITORY_ROOT / "deploy" / "release-manifest.json"
STANDALONE_MANIFEST_PATH = (
    REPOSITORY_ROOT / "deploy" / "release-manifest-standalone.json"
)
MIGRATION_MANIFEST_PATH = REPOSITORY_ROOT / "packages" / "db-schema" / "migration-manifest.json"
WRITER_SOURCES_PATH = REPOSITORY_ROOT / "deploy" / "database-release-writer-sources.json"
INSTALL_WORKFLOW_PATH = REPOSITORY_ROOT / ".github" / "workflows" / "test-install.yml"

CENTRAL_DESTRUCTIVE = "CENTRAL_NO_INLINE_MIGRATION_MUST_BE_NON_DESTRUCTIVE"
CENTRAL_INLINE_BACKUP = "CENTRAL_INLINE_BACKUP_COMMANDS_MUST_STAY_ABSENT"
STANDALONE_DESTRUCTIVE = "STANDALONE_MIGRATION_MUST_STAY_DESTRUCTIVE"
STANDALONE_BACKUP = "STANDALONE_BACKUP_COMMAND_MUST_STAY_PRESENT"
STANDALONE_VERIFY_BACKUP = "STANDALONE_VERIFY_BACKUP_COMMAND_MUST_STAY_PRESENT"
OWNERLESS_MIGRATION_DESTRUCTIVE = (
    "OWNERLESS_TERMINAL_GENERATION_CAS_MUST_BE_NON_DESTRUCTIVE"
)
HANIEL_PIN = "HANIEL_PINNED_CONTRACT_SHA_MUST_MATCH_CI"
HANIEL_MATRIX = "HANIEL_CONTRACT_MATRIX_MUST_NAME_PINNED_AND_ROLLING"
HANIEL_RUNTIME = "HANIEL_RUNTIME_CONTRACT_SHA_MUST_BE_PINNED_OR_ROLLING"
HANIEL_COMPOSITION = "HANIEL_COMPOSITION_MUST_RUN_PREFLIGHT_APPLY_LEDGER"


class ContractViolation(AssertionError):
    """One stable, grep-friendly prerequisite contract failure."""


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf8"))


def load_contract() -> dict[str, Any]:
    return load_json(CONTRACT_PATH)


def require(condition: bool, code: str, detail: str) -> None:
    if not condition:
        raise ContractViolation(f"{code}: {detail}")


def assert_central_manifest(payload: dict[str, Any]) -> None:
    migration = payload.get("migration", {})
    require(
        migration.get("destructive") is False,
        CENTRAL_DESTRUCTIVE,
        "central migration has no inline backup owner and must declare destructive=false",
    )
    for command_name in ("backup", "verify_backup"):
        require(
            command_name not in migration,
            CENTRAL_INLINE_BACKUP,
            f"central migration unexpectedly declares {command_name}",
        )


def assert_standalone_manifest(
    payload: dict[str, Any],
    contract: dict[str, Any] | None = None,
) -> None:
    contract = contract or load_contract()
    migration = payload.get("migration", {})
    require(
        migration.get("destructive") is True,
        STANDALONE_DESTRUCTIVE,
        "standalone migration owns backup and must declare destructive=true",
    )
    require(
        migration.get("backup")
        == contract["standalone"]["inline_backup_commands"]["backup"],
        STANDALONE_BACKUP,
        "standalone backup command is missing or differs",
    )
    require(
        migration.get("verify_backup")
        == contract["standalone"]["inline_backup_commands"]["verify_backup"],
        STANDALONE_VERIFY_BACKUP,
        "standalone verify_backup command is missing or differs",
    )


def assert_pending_migration(
    payload: dict[str, Any],
    migration_id: str = "076_ownerless_terminal_generation_cas.sql",
) -> None:
    migrations = payload.get("migrations", [])
    matches = [entry for entry in migrations if entry.get("id") == migration_id]
    require(
        len(matches) == 1,
        OWNERLESS_MIGRATION_DESTRUCTIVE,
        f"expected exactly one manifest entry for {migration_id}, found {len(matches)}",
    )
    require(
        matches[0].get("destructive") is False,
        OWNERLESS_MIGRATION_DESTRUCTIVE,
        f"{migration_id} must declare destructive=false",
    )


def assert_haniel_contract_matrix(
    contract: dict[str, Any],
    writer_sources: dict[str, Any],
    workflow: str,
) -> None:
    contracts = contract.get("haniel_contracts", {})
    require(
        set(contracts) == {"pinned", "rolling"}
        and all(isinstance(value, str) and len(value) == 40 for value in contracts.values()),
        HANIEL_MATRIX,
        "contract fixture must name exact pinned and rolling Haniel SHAs",
    )
    pinned = contracts["pinned"]
    require(
        writer_sources.get("haniel_contract_sha") == pinned and pinned in workflow,
        HANIEL_PIN,
        "writer source pin and install workflow must use the fixture pinned SHA",
    )


def installed_haniel_commit() -> str:
    direct_url = importlib.metadata.distribution("haniel").read_text("direct_url.json")
    require(
        direct_url is not None,
        HANIEL_RUNTIME,
        "Haniel must be installed from an exact VCS revision",
    )
    payload = json.loads(direct_url)
    commit = payload.get("vcs_info", {}).get("commit_id")
    require(
        isinstance(commit, str) and len(commit) == 40,
        HANIEL_RUNTIME,
        "installed Haniel direct_url.json has no exact commit_id",
    )
    return commit


def assert_installed_haniel_lane(contract: dict[str, Any]) -> None:
    allowed = set(contract["haniel_contracts"].values())
    commit = installed_haniel_commit()
    require(
        commit in allowed,
        HANIEL_RUNTIME,
        f"installed Haniel {commit} is outside the pinned/rolling contract matrix",
    )


def target_central_payload(payload: dict[str, Any]) -> dict[str, Any]:
    target = copy.deepcopy(payload)
    target["migration"]["destructive"] = False
    target["migration"].pop("backup", None)
    target["migration"].pop("verify_backup", None)
    return target


def assert_ordered_trace(
    actual: list[str],
    required: list[str],
    *,
    label: str,
) -> None:
    missing = [item for item in required if actual.count(item) != 1]
    require(
        not missing,
        HANIEL_COMPOSITION,
        f"{label} must contain every required owner exactly once; invalid={missing}",
    )
    indices = [actual.index(item) for item in required]
    require(
        indices == sorted(indices),
        HANIEL_COMPOSITION,
        f"{label} owner order differs: actual={actual}, required={required}",
    )
