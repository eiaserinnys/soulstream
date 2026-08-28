"""Strict RED for Soulstream's Haniel/DB release prerequisite."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from haniel.core.deployment import DeploymentCallbacks, DeploymentCoordinator
from haniel.core.deployment_command_runner import CommandResult
from haniel.core.deployment_state import DeploymentStateStore
from haniel.core.release_manifest import ReleaseManifest

from ci_prerequisite_contract import (
    CENTRAL_MANIFEST_PATH,
    INSTALL_WORKFLOW_PATH,
    MIGRATION_MANIFEST_PATH,
    STANDALONE_MANIFEST_PATH,
    WRITER_SOURCES_PATH,
    assert_central_manifest,
    assert_haniel_contract_matrix,
    assert_installed_haniel_lane,
    assert_ordered_trace,
    assert_pending_migration,
    assert_standalone_manifest,
    load_contract,
    load_json,
    target_central_payload,
)


class CiPrerequisiteStrictTest(unittest.TestCase):
    def setUp(self) -> None:
        self.contract = load_contract()
        self.central = load_json(CENTRAL_MANIFEST_PATH)

    def test_central_no_inline_manifest_is_non_destructive(self) -> None:
        assert_central_manifest(self.central)

    def test_standalone_keeps_destructive_backup_ownership(self) -> None:
        assert_standalone_manifest(
            load_json(STANDALONE_MANIFEST_PATH),
            self.contract,
        )

    def test_ownerless_terminal_generation_cas_stays_non_destructive(self) -> None:
        assert_pending_migration(load_json(MIGRATION_MANIFEST_PATH))

    def test_pinned_and_rolling_haniel_contract_lanes_are_explicit(self) -> None:
        assert_haniel_contract_matrix(
            self.contract,
            load_json(WRITER_SOURCES_PATH),
            INSTALL_WORKFLOW_PATH.read_text(encoding="utf8"),
        )
        assert_installed_haniel_lane(self.contract)

    def test_central_target_runs_preflight_apply_and_migration_ledger_verify(
        self,
    ) -> None:
        payload = target_central_payload(self.central)
        assert_central_manifest(payload)
        manifest = ReleaseManifest.model_validate(payload)
        command_trace: list[str] = []

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def run_command(spec, _environment):
                command_trace.append(spec.name)
                if spec.name == manifest.migration.preflight.name:
                    return CommandResult(
                        stdout="{}",
                        json_data={
                            "schema_version": "soulstream.database-release.v1",
                            "ok": True,
                            "operation": "upgrade",
                            "journal_path": str(root / "database-release.json"),
                        },
                    )
                return CommandResult(stdout="", json_data=None)

            store = DeploymentStateStore(root / "deployments")
            coordinator = DeploymentCoordinator(
                state_store=store,
                command_runner=run_command,
            )
            receipt = {
                "request_id": "request-1",
                "repo": "soulstream",
                "target_head": "target",
                "owner_instance": "owner-1",
                "quiescence_nonce": "nonce-1",
                "stopped_services": ["soulstream-orch-server"],
                "already_stopped_services": [],
                "quiesced_services": ["soulstream-orch-server"],
            }
            result = coordinator.execute(
                repo_name="soulstream",
                previous_head="previous",
                target_head="target",
                manifest=manifest,
                callbacks=DeploymentCallbacks(
                    build=lambda: None,
                    stop=lambda: receipt,
                    start_and_wait=lambda: None,
                    rollback=lambda: None,
                    prepare_roll_forward=lambda: None,
                    writer_services=("soulstream-orch-server",),
                    owner_instance="owner-1",
                    quiescence_nonce="nonce-1",
                ),
                expected_operation="upgrade",
                request_id="request-1",
            )
            journal = store.read("soulstream")

        self.assertEqual(result.status, "success")
        self.assertIsNotNone(journal)
        assert journal is not None
        assert_ordered_trace(
            command_trace,
            self.contract["composition"]["required_command_order"],
            label="Haniel command trace",
        )
        assert_ordered_trace(
            [entry["state"] for entry in journal["history"]],
            self.contract["composition"]["required_state_order"],
            label="Haniel deployment journal",
        )


if __name__ == "__main__":
    unittest.main()
