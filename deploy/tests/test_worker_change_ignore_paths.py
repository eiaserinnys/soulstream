"""Keep worker change ignores away from worker and build inputs."""

from __future__ import annotations

import unittest

from haniel.core.release_manifest import ReleaseManifest
from haniel.core.restart_filter import paths_all_ignored

from test_service_restart_filters import ROOT, protected_paths, repository_files, violations


class WorkerChangeIgnorePathsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.patterns = ReleaseManifest.load(
            ROOT / "deploy/release-manifest-worker.json"
        ).change_ignore_paths
        cls.files = repository_files()
        cls.protected = protected_paths("soul-server-ts", cls.files) | {
            path for path in cls.files if path.startswith(("packages/db-schema/", "plugins/"))
        }

    def test_worker_and_build_inputs_are_never_ignored(self) -> None:
        self.assertEqual(violations(self.protected, self.patterns), [])

    def test_guard_detects_injected_build_inputs(self) -> None:
        examples = (
            ("packages/db-schema/migration-manifest.json", "packages/db-schema/*"),
            ("plugins/chatgpt-card-renderer/src/widget-html.ts", "plugins/*"),
            ("packages/wire-schema/src/attachments.ts", "packages/wire-schema/*"),
            ("soul-app/package.json", "soul-app/*"),
        )
        for path, pattern in examples:
            with self.subTest(path=path):
                self.assertIn(path, self.protected)
                self.assertIn((path, pattern), violations(self.protected, [pattern]))

    def test_representative_changes(self) -> None:
        ignored = ("soul-app/src/x.ts", "docs/x.md", ".github/workflows/soul-app.yml")
        for path in ignored:
            with self.subTest(path=path):
                self.assertTrue(paths_all_ignored([path], self.patterns))
        self.assertTrue(paths_all_ignored(list(ignored), self.patterns))
        for path in (
            "soul-server-ts/src/x.ts",
            "packages/wire-schema/src/x.ts",
            "packages/db-schema/migration-manifest.json",
            "plugins/chatgpt-card-renderer/src/widget-html.ts",
            "soul-app/package.json",
            "soul-app/modules/soul-app-search-commands/package.json",
            "pnpm-lock.yaml",
            "deploy/release-manifest-worker.json",
        ):
            with self.subTest(path=path):
                self.assertFalse(paths_all_ignored([path], self.patterns))
                self.assertFalse(paths_all_ignored([*ignored, path], self.patterns))


if __name__ == "__main__":
    unittest.main()
