"""Mutation witnesses proving each CI prerequisite oracle can fail."""

from __future__ import annotations

import copy
import unittest

from ci_prerequisite_contract import (
    CENTRAL_DESTRUCTIVE,
    CENTRAL_MANIFEST_PATH,
    HANIEL_COMPOSITION,
    HANIEL_MATRIX,
    HANIEL_PIN,
    INSTALL_WORKFLOW_PATH,
    MIGRATION_MANIFEST_PATH,
    OWNERLESS_MIGRATION_DESTRUCTIVE,
    STANDALONE_BACKUP,
    STANDALONE_DESTRUCTIVE,
    STANDALONE_MANIFEST_PATH,
    STANDALONE_VERIFY_BACKUP,
    WRITER_SOURCES_PATH,
    ContractViolation,
    assert_central_manifest,
    assert_haniel_contract_matrix,
    assert_ordered_trace,
    assert_pending_migration,
    assert_standalone_manifest,
    load_contract,
    load_json,
    target_central_payload,
)


class CiPrerequisiteMutationTest(unittest.TestCase):
    def assert_named_violation(self, code: str, action) -> None:
        with self.assertRaisesRegex(ContractViolation, rf"^{code}:"):
            action()

    def test_central_false_to_true_is_detected(self) -> None:
        mutated = target_central_payload(load_json(CENTRAL_MANIFEST_PATH))
        mutated["migration"]["destructive"] = True
        self.assert_named_violation(
            CENTRAL_DESTRUCTIVE,
            lambda: assert_central_manifest(mutated),
        )

    def test_ownerless_terminal_stale_event_cas_false_to_true_is_detected(self) -> None:
        mutated = load_json(MIGRATION_MANIFEST_PATH)
        entry = next(
            item
            for item in mutated["migrations"]
            if item["id"] == "077_ownerless_terminal_stale_event_cas.sql"
        )
        entry["destructive"] = True
        self.assert_named_violation(
            OWNERLESS_MIGRATION_DESTRUCTIVE,
            lambda: assert_pending_migration(mutated),
        )

    def test_standalone_destructive_false_is_detected(self) -> None:
        mutated = load_json(STANDALONE_MANIFEST_PATH)
        mutated["migration"]["destructive"] = False
        self.assert_named_violation(
            STANDALONE_DESTRUCTIVE,
            lambda: assert_standalone_manifest(mutated),
        )

    def test_standalone_missing_backup_is_detected(self) -> None:
        mutated = load_json(STANDALONE_MANIFEST_PATH)
        mutated["migration"].pop("backup")
        self.assert_named_violation(
            STANDALONE_BACKUP,
            lambda: assert_standalone_manifest(mutated),
        )

    def test_standalone_missing_verify_backup_is_detected(self) -> None:
        mutated = load_json(STANDALONE_MANIFEST_PATH)
        mutated["migration"].pop("verify_backup")
        self.assert_named_violation(
            STANDALONE_VERIFY_BACKUP,
            lambda: assert_standalone_manifest(mutated),
        )

    def test_standalone_backup_command_drift_is_detected(self) -> None:
        mutated = load_json(STANDALONE_MANIFEST_PATH)
        mutated["migration"]["backup"]["command"] = "node mutated-backup.mjs"
        self.assert_named_violation(
            STANDALONE_BACKUP,
            lambda: assert_standalone_manifest(mutated),
        )

    def test_standalone_verify_backup_command_drift_is_detected(self) -> None:
        mutated = load_json(STANDALONE_MANIFEST_PATH)
        mutated["migration"]["verify_backup"]["command"] = (
            "node mutated-verify-backup.mjs"
        )
        self.assert_named_violation(
            STANDALONE_VERIFY_BACKUP,
            lambda: assert_standalone_manifest(mutated),
        )

    def test_each_required_composition_owner_deletion_is_detected(self) -> None:
        required = load_contract()["composition"]["required_command_order"]
        for deleted in required:
            with self.subTest(deleted=deleted):
                mutated = [item for item in required if item != deleted]
                self.assert_named_violation(
                    HANIEL_COMPOSITION,
                    lambda mutated=mutated: assert_ordered_trace(
                        mutated,
                        required,
                        label="mutated Haniel command trace",
                    ),
                )

    def test_pinned_sha_drift_is_detected(self) -> None:
        contract = load_contract()
        mutated_sources = load_json(WRITER_SOURCES_PATH)
        mutated_sources["haniel_contract_sha"] = "f" * 40
        self.assert_named_violation(
            HANIEL_PIN,
            lambda: assert_haniel_contract_matrix(
                contract,
                mutated_sources,
                INSTALL_WORKFLOW_PATH.read_text(encoding="utf8"),
            ),
        )

    def test_missing_rolling_lane_is_detected(self) -> None:
        mutated = copy.deepcopy(load_contract())
        mutated["haniel_contracts"].pop("rolling")
        self.assert_named_violation(
            HANIEL_MATRIX,
            lambda: assert_haniel_contract_matrix(
                mutated,
                load_json(WRITER_SOURCES_PATH),
                INSTALL_WORKFLOW_PATH.read_text(encoding="utf8"),
            ),
        )


if __name__ == "__main__":
    unittest.main()
