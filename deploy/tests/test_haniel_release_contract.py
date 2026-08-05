"""Cross-repository availability contract for the actual Soulstream manifest."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from haniel.core.deployment import (
    DeploymentCallbacks,
    DeploymentCoordinator,
    DeploymentError,
    DeploymentStateStore,
    ReleaseManifest,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = REPOSITORY_ROOT / "deploy" / "release-manifest.json"
WORKER_MANIFEST_PATH = REPOSITORY_ROOT / "deploy" / "release-manifest-worker.json"
STANDALONE_MANIFEST_PATH = (
    REPOSITORY_ROOT / "deploy" / "release-manifest-standalone.json"
)
DEPLOY_COMMAND = "pnpm --dir orch-server-ts run deploy:ydoc-runbook-residue --"


class SoulstreamReleaseContractTest(unittest.TestCase):
    def test_actual_manifests_scope_board_ydoc_migration_to_the_deploy_runner(
        self,
    ) -> None:
        central = ReleaseManifest.load(MANIFEST_PATH)
        worker = ReleaseManifest.load(WORKER_MANIFEST_PATH)
        standalone = ReleaseManifest.load(STANDALONE_MANIFEST_PATH)

        self.assertEqual(
            central.migration.apply.command,
            f"{DEPLOY_COMMAND} --migrate",
        )
        for manifest in (central, worker, standalone):
            verify = [
                command
                for command in manifest.post_start_verify
                if command.name == "verify-board-yjs-runbook-residue"
            ]
            self.assertEqual(len(verify), 1)
            self.assertEqual(verify[0].command, f"{DEPLOY_COMMAND} --verify")

    def test_ydoc_migration_failure_reaches_previous_release_fallback(self) -> None:
        manifest = ReleaseManifest.load(MANIFEST_PATH)

        with tempfile.TemporaryDirectory() as directory:
            events: list[str] = []

            def run_command(spec, environment) -> None:
                self.assertEqual(environment["HANIEL_PREVIOUS_HEAD"], "previous")
                events.append(spec.name)
                if spec.name == "apply-migrations-and-board-yjs-residue":
                    raise RuntimeError("Y.Doc migration failed")
                if spec.name == "verify-board-yjs-runbook-residue":
                    raise RuntimeError("Y.Doc residue remains")

            callbacks = DeploymentCallbacks(
                build=lambda: events.append("build"),
                stop=lambda: events.append("stop"),
                start_and_wait=lambda: events.append("start-and-wait"),
                rollback=lambda: events.append("rollback-previous-release"),
                prepare_roll_forward=lambda: events.append("prepare-roll-forward"),
            )
            coordinator = DeploymentCoordinator(
                state_store=DeploymentStateStore(Path(directory)),
                command_runner=run_command,
            )

            with self.assertRaises(DeploymentError) as raised:
                coordinator.execute(
                    repo_name="soulstream",
                    previous_head="previous",
                    target_head="target",
                    manifest=manifest,
                    callbacks=callbacks,
                )

            self.assertTrue(raised.exception.recovered)
            self.assertEqual(events[-2:], [
                "recover-previous-release-data",
                "rollback-previous-release",
            ])

    def test_persistent_health_failures_restore_previous_release(self) -> None:
        manifest = ReleaseManifest.load(MANIFEST_PATH)
        self.assertEqual(
            manifest.recovery.fallback.name,
            "recover-previous-release-data",
        )

        for failure in ("http-500", "mcp", "canonical-data", "node-registration"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                events: list[str] = []

                def run_command(spec, environment) -> None:
                    self.assertEqual(environment["HANIEL_PREVIOUS_HEAD"], "previous")
                    events.append(spec.name)
                    if spec.name == "verify-release-health":
                        raise RuntimeError(f"persistent {failure} failure")

                callbacks = DeploymentCallbacks(
                    build=lambda: events.append("build"),
                    stop=lambda: events.append("stop"),
                    start_and_wait=lambda: events.append("start-and-wait"),
                    rollback=lambda: events.append("rollback-previous-release"),
                    prepare_roll_forward=lambda: events.append("prepare-roll-forward"),
                )
                coordinator = DeploymentCoordinator(
                    state_store=DeploymentStateStore(Path(directory)),
                    command_runner=run_command,
                )

                with self.assertRaises(DeploymentError) as raised:
                    coordinator.execute(
                        repo_name="soulstream",
                        previous_head="previous",
                        target_head="target",
                        manifest=manifest,
                        callbacks=callbacks,
                    )

                self.assertTrue(raised.exception.recovered)
                self.assertEqual(events[-2:], [
                    "recover-previous-release-data",
                    "rollback-previous-release",
                ])
                self.assertEqual(events.count("verify-release-health"), 2)


if __name__ == "__main__":
    unittest.main()
