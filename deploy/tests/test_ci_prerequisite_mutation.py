"""Mutation witnesses proving each CI prerequisite oracle can fail."""

from __future__ import annotations

import copy
import unittest

from ci_prerequisite_contract import (
    CENTRAL_MANIFEST_PATH,
    HANIEL_COMPOSITION,
    HANIEL_MATRIX,
    HANIEL_PIN,
    INSTALL_WORKFLOW_PATH,
    MIGRATION_POLICY_FIELDS_ABSENT,
    STANDALONE_MANIFEST_PATH,
    WRITER_SOURCES_PATH,
    ContractViolation,
    assert_central_manifest,
    assert_haniel_contract_matrix,
    assert_ordered_trace,
    assert_standalone_manifest,
    load_contract,
    load_json,
)


class CiPrerequisiteMutationTest(unittest.TestCase):
    def assert_named_violation(self, code: str, action) -> None:
        with self.assertRaisesRegex(ContractViolation, rf"^{code}:"):
            action()

    def test_retired_policy_field_reintroduction_is_detected(self) -> None:
        for path, assertion in (
            (CENTRAL_MANIFEST_PATH, assert_central_manifest),
            (STANDALONE_MANIFEST_PATH, assert_standalone_manifest),
        ):
            for field, value in (
                ("destructive", True),
                ("backup", {"name": "retired", "command": "false"}),
                ("verify_backup", {"name": "retired", "command": "false"}),
            ):
                with self.subTest(manifest=path.name, field=field):
                    mutated = load_json(path)
                    mutated["migration"][field] = value
                    self.assert_named_violation(
                        MIGRATION_POLICY_FIELDS_ABSENT,
                        lambda mutated=mutated, assertion=assertion: assertion(mutated),
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
