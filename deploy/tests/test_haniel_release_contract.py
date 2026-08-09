"""Cross-repository availability contract for the actual Soulstream manifest."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import shlex
import unittest
from pathlib import Path

import yaml
from haniel.core.deployment import (
    ReleaseManifest,
)
from haniel.config import HanielConfig
from haniel.core.runner import ServiceRunner

from deploy.generate_haniel_writer_projection import (
    extract_writer_graph,
    render_haniel_projection,
    verify_committed_projection,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = REPOSITORY_ROOT / "deploy" / "release-manifest.json"
WORKER_MANIFEST_PATH = REPOSITORY_ROOT / "deploy" / "release-manifest-worker.json"
STANDALONE_MANIFEST_PATH = (
    REPOSITORY_ROOT / "deploy" / "release-manifest-standalone.json"
)
CENTRAL_DATABASE_CONTRACT_PATH = (
    REPOSITORY_ROOT / "deploy" / "database-release-central.json"
)
STANDALONE_DATABASE_CONTRACT_PATH = (
    REPOSITORY_ROOT / "deploy" / "database-release-standalone.json"
)
DEPLOY_COMMAND = (
    "node orch-server-ts/node_modules/tsx/dist/cli.mjs "
    "orch-server-ts/scripts/deploy-board-yjs-runbook-residue.ts"
)
WRITER_SOURCES_PATH = (
    REPOSITORY_ROOT / "deploy" / "database-release-writer-sources.json"
)


class SoulstreamReleaseContractTest(unittest.TestCase):
    def test_database_writer_inventory_matches_haniel_affected_service_callback(
        self,
    ) -> None:
        cases = (
            (
                "central",
                MANIFEST_PATH,
                CENTRAL_DATABASE_CONTRACT_PATH,
            ),
            (
                "standalone",
                STANDALONE_MANIFEST_PATH,
                STANDALONE_DATABASE_CONTRACT_PATH,
            ),
        )
        for source_name, manifest_path, contract_path in cases:
            with self.subTest(manifest=manifest_path.name):
                manifest = ReleaseManifest.load(manifest_path)
                contract = json.loads(contract_path.read_text(encoding="utf8"))
                config = _load_writer_source(source_name)
                runner = ServiceRunner(config, config_dir=REPOSITORY_ROOT)
                affected = sorted(runner.get_affected_services("soulstream"))
                self.assertEqual(affected, sorted(contract["writer_services"]))
                self.assertIn(manifest.environment_service, affected)

        worker = ReleaseManifest.load(WORKER_MANIFEST_PATH)
        self.assertIsNone(worker.migration)
        self.assertFalse(
            (REPOSITORY_ROOT / "deploy" / "database-release-worker.json").exists()
        )

    def test_writer_sidecar_drift_is_detected_after_real_config_loading(self) -> None:
        source = _writer_source("central")
        provenance = json.loads(
            (REPOSITORY_ROOT / source["provenance_path"]).read_text(encoding="utf8")
        )
        payload = provenance["writer_graph"]
        contract = json.loads(
            CENTRAL_DATABASE_CONTRACT_PATH.read_text(encoding="utf8")
        )

        added = copy.deepcopy(payload)
        added["services"]["database-writer-drift"] = {
            "repo": "soulstream",
            "after": [],
        }
        with self.assertRaises(AssertionError):
            _assert_writer_services(
                HanielConfig.model_validate(yaml.safe_load(render_haniel_projection(added))),
                contract["writer_services"],
            )

        removed = copy.deepcopy(payload)
        removed["services"].pop(contract["writer_services"][0])
        with self.assertRaises(AssertionError):
            _assert_writer_services(
                HanielConfig.model_validate(yaml.safe_load(render_haniel_projection(removed))),
                contract["writer_services"],
            )

    def test_committed_writer_projection_has_source_provenance(self) -> None:
        source = _writer_source("central")
        live_source = os.environ.get("HANIEL_LIVE_CONFIG_PATH")
        verification = verify_committed_projection(
            repository_root=REPOSITORY_ROOT,
            source=source,
            live_source=Path(live_source) if live_source else None,
        )
        self.assertEqual(verification["fixture"], "verified")
        if live_source:
            self.assertEqual(verification["live_source"], "verified")
            raw = Path(live_source).read_bytes()
            self.assertEqual(
                extract_writer_graph(yaml.safe_load(raw)),
                json.loads(
                    (REPOSITORY_ROOT / source["provenance_path"])
                    .read_text(encoding="utf8")
                )["writer_graph"],
            )
        else:
            self.assertEqual(verification["live_source"], "not_requested")

    def test_disabled_writer_has_exact_actual_and_projection_affected_set(self) -> None:
        source = _writer_source("central")
        live_source = os.environ.get("HANIEL_LIVE_CONFIG_PATH")
        if live_source:
            payload = yaml.safe_load(Path(live_source).read_text(encoding="utf8"))
        else:
            provenance = json.loads(
                (REPOSITORY_ROOT / source["provenance_path"])
                .read_text(encoding="utf8")
            )
            payload = yaml.safe_load(render_haniel_projection(provenance["writer_graph"]))
        payload["services"]["soulstream-soul-server-ts"]["enabled"] = False

        actual = HanielConfig.model_validate(payload)
        projected = HanielConfig.model_validate(
            yaml.safe_load(render_haniel_projection(extract_writer_graph(payload)))
        )
        actual_affected = sorted(
            ServiceRunner(actual, config_dir=REPOSITORY_ROOT)
            .get_affected_services("soulstream")
        )
        projected_affected = sorted(
            ServiceRunner(projected, config_dir=REPOSITORY_ROOT)
            .get_affected_services("soulstream")
        )
        self.assertEqual(actual_affected, ["soulstream-orch-server"])
        self.assertEqual(projected_affected, actual_affected)

    def test_actual_manifests_scope_board_ydoc_migration_to_the_central_manifest(
        self,
    ) -> None:
        central = ReleaseManifest.load(MANIFEST_PATH)
        worker = ReleaseManifest.load(WORKER_MANIFEST_PATH)
        standalone = ReleaseManifest.load(STANDALONE_MANIFEST_PATH)

        self.assertEqual(
            central.migration.apply.command,
            f"{DEPLOY_COMMAND} --migrate",
        )
        central_verify = [
            command
            for command in central.post_start_verify
            if command.name == "verify-board-yjs-runbook-residue"
        ]
        self.assertEqual(len(central_verify), 1)
        self.assertEqual(central_verify[0].command, f"{DEPLOY_COMMAND} --verify")
        for manifest in (worker, standalone):
            self.assertNotIn(
                "verify-board-yjs-runbook-residue",
                {command.name for command in manifest.post_start_verify},
            )

    def test_actual_manifest_commands_do_not_use_bare_pnpm_or_tsx(self) -> None:
        for path in (
            MANIFEST_PATH,
            WORKER_MANIFEST_PATH,
            STANDALONE_MANIFEST_PATH,
        ):
            manifest = json.loads(path.read_text(encoding="utf8"))
            for command in _find_commands(manifest):
                with self.subTest(manifest=path.name, command=command):
                    self.assertNotIn(shlex.split(command)[0], {"pnpm", "tsx"})

    def test_database_manifests_use_the_operation_aware_result_contract(self) -> None:
        for path, scope in (
            (MANIFEST_PATH, "cluster"),
            (STANDALONE_MANIFEST_PATH, "standalone"),
        ):
            with self.subTest(manifest=path.name):
                manifest = ReleaseManifest.load(path)
                self.assertIsNotNone(manifest.migration)
                migration = manifest.migration
                assert migration is not None
                self.assertEqual(migration.operation, "discover")
                self.assertEqual(
                    migration.result_contract,
                    "soulstream.database-release.v1",
                )
                self.assertIsNotNone(migration.provenance_probe)
                self.assertIn("release-executor.mjs", migration.preflight.command)
                self.assertIn("release-executor.mjs", migration.backup.command)
                self.assertIn("release-executor.mjs", migration.verify_backup.command)
                self.assertIn("release-executor.mjs", manifest.recovery.command.command)
                for command in _find_commands(
                    json.loads(path.read_text(encoding="utf8"))
                ):
                    if "release-executor.mjs" in command:
                        self.assertIn("--database-contract", command)
                health = next(
                    command
                    for command in manifest.post_start_verify
                    if command.name == "verify-release-health"
                )
                self.assertIn(f"--scope {scope}", health.command)

    def test_new_haniel_keeps_legacy_optional_fields_backward_compatible(self) -> None:
        payload = json.loads(MANIFEST_PATH.read_text(encoding="utf8"))
        migration = payload["migration"]
        for field in ("operation", "result_contract", "provenance_probe"):
            migration.pop(field)

        parsed = ReleaseManifest.model_validate(payload)

        self.assertIsNone(parsed.migration.operation)
        self.assertIsNone(parsed.migration.result_contract)
        self.assertIsNone(parsed.migration.provenance_probe)


def _find_commands(value: object) -> list[str]:
    if isinstance(value, dict):
        commands = (
            [value["command"]] if isinstance(value.get("command"), str) else []
        )
        return commands + [
            command
            for child in value.values()
            for command in _find_commands(child)
        ]
    if isinstance(value, list):
        return [command for child in value for command in _find_commands(child)]
    return []


def _writer_source(name: str) -> dict[str, str]:
    sources = json.loads(WRITER_SOURCES_PATH.read_text(encoding="utf8"))
    return sources["sources"][name]


def _render_source(source: dict[str, str]) -> str:
    path = REPOSITORY_ROOT / source["path"]
    raw = path.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == source["sha256"]
    rendered = raw.decode("utf8")
    replacements = {
        "__INSTALL_DIR__": "C:/soulstream-test",
        "__WORKSPACE_DIR__": "C:/workspace-test",
        "__PORT__": "3105",
        "__DATABASE_URL__": "postgresql://test:test@127.0.0.1/test_db",
        "__AUTH_BEARER_TOKEN__": "test-token",
        "__REPOSITORY_URL__": "https://example.invalid/soulstream.git",
        "__REPOSITORY_BRANCH__": "main",
    }
    for marker, value in replacements.items():
        rendered = rendered.replace(marker, value)
    return rendered


def _load_writer_source(name: str) -> HanielConfig:
    return HanielConfig.model_validate(yaml.safe_load(_render_source(_writer_source(name))))


def _assert_writer_services(config: HanielConfig, expected: list[str]) -> None:
    actual = sorted(
        ServiceRunner(config, config_dir=REPOSITORY_ROOT)
        .get_affected_services("soulstream")
    )
    assert actual == sorted(expected)


if __name__ == "__main__":
    unittest.main()
