"""Keep worker change ignores away from worker and build inputs."""

from __future__ import annotations

import unittest

from haniel.core.release_manifest import ReleaseManifest
from haniel.core.restart_filter import paths_all_ignored

from test_service_restart_filters import (
    ROOT, protected_paths, repository_files, violations, workspace_packages,
)

PR_2370_CHANGED_FILES = (
    "scripts/visual-check/settings_toolbar.py",
    "scripts/visual-check/settings_toolbar_fakes.py",
    "scripts/visual-check/settings_toolbar_r2.py",
    "unified-dashboard/client/components/claude-accounts/ClaudePoolRow.test.tsx",
    "unified-dashboard/client/components/claude-accounts/ClaudePoolRow.tsx",
    "unified-dashboard/client/v3/ClaudeAccountPoolReviewSample.tsx",
    "unified-dashboard/client/v3/ComponentsReviewPage.tsx",
    "unified-dashboard/client/v3/PersistentSessionEmptyState.tsx",
    "unified-dashboard/client/v3/PersistentSessionScreen.test.tsx",
    "unified-dashboard/client/v3/SettingsToolbarReviewSamples.tsx",
    "unified-dashboard/client/v3/persistent-session-screen.css",
    "unified-dashboard/scripts/visual-check/provider_panel.py",
)


class WorkerChangeIgnorePathsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.patterns = ReleaseManifest.load(
            ROOT / "deploy/release-manifest-worker.json"
        ).change_ignore_paths
        cls.files = repository_files()
        cls.protected = protected_paths(
            "soul-server-ts", cls.files, workspace_package_manifests_only=True
        ) | {
            path for path in cls.files if path.startswith(("packages/db-schema/", "plugins/"))
        }

    def test_worker_and_build_inputs_are_never_ignored(self) -> None:
        self.assertEqual(violations(self.protected, self.patterns), [])

    def test_guard_detects_injected_build_inputs(self) -> None:
        examples = (
            ("packages/db-schema/migration-manifest.json", "packages/db-schema/*"),
            ("plugins/chatgpt-card-renderer/src/widget-html.ts", "plugins/*"),
            ("packages/wire-schema/src/attachments.ts", "packages/wire-schema/*"),
            ("unified-dashboard/package.json", "unified-dashboard/*"),
        )
        for path, pattern in examples:
            with self.subTest(path=path):
                self.assertIn(path, self.protected)
                self.assertIn((path, pattern), violations(self.protected, [pattern]))

    def test_workspace_manifests_are_protected_but_soul_app_is_not(self) -> None:
        manifests = {
            (directory / "package.json").relative_to(ROOT).as_posix()
            for directory in workspace_packages().values()
        }
        self.assertTrue({"package.json", *manifests} <= self.protected)
        self.assertNotIn("soul-app/package.json", self.protected)
        self.assertNotIn("soul-app/modules/soul-app-search-commands/package.json", self.protected)

    def test_representative_changes(self) -> None:
        ignored = (
            "soul-app/src/x.ts", "soul-app/package.json",
            "soul-app/modules/soul-app-search-commands/package.json",
            "docs/x.md", ".github/workflows/soul-app.yml",
            "packages/i18n/src/index.ts", "packages/i18n/GLOSSARY.md",
            "scripts/visual-check/settings_toolbar.py", "scripts/visual-check/sub/x.py",
        )
        for path in ignored:
            with self.subTest(path=path):
                self.assertTrue(paths_all_ignored([path], self.patterns))
        self.assertTrue(paths_all_ignored(list(ignored), self.patterns))
        self.assertTrue(paths_all_ignored(list(PR_2370_CHANGED_FILES), self.patterns))
        for path in (
            "soul-server-ts/src/x.ts",
            "packages/i18n/package.json",
            "packages/wire-schema/src/x.ts",
            "packages/db-schema/migration-manifest.json",
            "plugins/chatgpt-card-renderer/src/widget-html.ts",
            "package.json",
            "unified-dashboard/package.json",
            "pnpm-lock.yaml",
            "deploy/release-manifest-worker.json",
            "scripts/verify-bundle-load.mjs",
            "scripts/check-ui-css.mjs",
        ):
            with self.subTest(path=path):
                self.assertFalse(paths_all_ignored([path], self.patterns))
                self.assertFalse(paths_all_ignored([*ignored, path], self.patterns))


if __name__ == "__main__":
    unittest.main()
