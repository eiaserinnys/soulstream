"""Keep central restart filters away from service and build inputs."""

from __future__ import annotations

import fnmatch
import json
import os
import unittest
from pathlib import Path

import yaml
from haniel.core.release_manifest import ReleaseManifest
from haniel.core.restart_filter import paths_all_ignored

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "deploy/release-manifest.json"
SERVICES = {
    "soulstream-orch-server": "orch-server-ts",
    "soulstream-soul-server-ts": "soul-server-ts",
}
GENERATED_DIRS = {".git", "node_modules", "dist", "build", "coverage", ".venv", ".turbo", "__pycache__", "test-results"}
DEPENDENCY_FIELDS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")


def repository_files() -> set[str]:
    files = set()
    for directory, dirs, names in os.walk(ROOT):
        dirs[:] = [name for name in dirs if name not in GENERATED_DIRS]
        for name in names:
            files.add((Path(directory) / name).relative_to(ROOT).as_posix())
    return files


def workspace_packages() -> dict[str, Path]:
    workspace = yaml.safe_load((ROOT / "pnpm-workspace.yaml").read_text(encoding="utf8"))
    packages = {}
    for pattern in workspace["packages"]:
        for directory in ROOT.glob(pattern):
            manifest = directory / "package.json"
            if manifest.is_file():
                package = json.loads(manifest.read_text(encoding="utf8"))
                packages[package["name"]] = directory
    return packages


def service_packages(service_dir: str) -> set[str]:
    packages = workspace_packages()
    pending = [ROOT / service_dir]
    visited: set[Path] = set()
    while pending:
        directory = pending.pop()
        if directory in visited:
            continue
        visited.add(directory)
        package = json.loads((directory / "package.json").read_text(encoding="utf8"))
        for field in DEPENDENCY_FIELDS:
            for name, version in package.get(field, {}).items():
                if isinstance(version, str) and version.startswith("workspace:"):
                    if name not in packages:
                        raise AssertionError(f"workspace dependency {name} not found for {directory}")
                    pending.append(packages[name])
    return {directory.relative_to(ROOT).as_posix() for directory in visited}


def is_test_file(path: str, package_dir: str) -> bool:
    relative = path[len(package_dir) + 1 :]
    return (
        relative.startswith(("tests/", "__tests__/"))
        or ".test." in Path(relative).name
        or ".spec." in Path(relative).name
    )


def protected_paths(
    service_dir: str, files: set[str], *, workspace_package_manifests_only: bool = False
) -> set[str]:
    package_dirs = service_packages(service_dir)
    workspace_manifests = {
        (directory / "package.json").relative_to(ROOT).as_posix()
        for directory in workspace_packages().values()
    } | {"package.json"}
    protected = {
        path
        for path in files
        if any(path.startswith(directory + "/") and not is_test_file(path, directory) for directory in package_dirs)
        or (path.startswith(("plugins/", "patches/", "deploy/", "scripts/")) and not path.startswith("scripts/visual-check/"))  # 시각 검사 스크립트는 워커 빌드와 실행에 쓰이지 않는다
        or (path in workspace_manifests if workspace_package_manifests_only else Path(path).name == "package.json")
        or path in {"pnpm-lock.yaml", "pnpm-workspace.yaml"}
    }
    return protected


def violations(paths: set[str], patterns: list[str]) -> list[tuple[str, str]]:
    return [
        (path, pattern)
        for path in sorted(paths)
        if paths_all_ignored([path], patterns)
        for pattern in patterns
        if fnmatch.fnmatchcase(path, pattern)
    ]


class ServiceRestartFiltersTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = ReleaseManifest.load(MANIFEST)
        cls.files = repository_files()

    def test_service_and_build_inputs_are_never_ignored(self) -> None:
        self.assertEqual(set(self.manifest.service_restart_filters), set(SERVICES))
        for service, directory in SERVICES.items():
            with self.subTest(service=service):
                patterns = self.manifest.service_restart_filters[service].ignore_paths
                self.assertEqual(violations(protected_paths(directory, self.files), patterns), [])

    def test_representative_unrelated_paths_are_ignored(self) -> None:
        examples = {
            "soulstream-orch-server": ["soul-app/src/api/types.ts", "docs/guide/deployment.md", "unified-dashboard/client/App.tsx"],
            "soulstream-soul-server-ts": ["orch-server-ts/src/production_main.ts"],
        }
        common = [
            "chrome-extension/public/manifest.json",
            "soul-app/component-review/review.css",
            "soul-app/modules/soul-app-search-commands/expo-module.config.json",
        ]
        for service, paths in examples.items():
            patterns = self.manifest.service_restart_filters[service].ignore_paths
            for path in paths + common:
                with self.subTest(service=service, path=path):
                    self.assertIn(path, self.files)
                    self.assertTrue(paths_all_ignored([path], patterns))

    def test_guard_detects_injected_plugin_and_dependency_filters(self) -> None:
        for directory in SERVICES.values():
            protected = protected_paths(directory, self.files)
            plugin = "plugins/chatgpt-card-renderer/src/widget-html.ts"
            dependency = "packages/wire-schema/src/attachments.ts"
            for path, pattern in ((plugin, "plugins/*"), (dependency, "packages/wire-schema/*")):
                with self.subTest(service=directory, path=path):
                    self.assertIn(path, protected)
                    self.assertIn((path, pattern), violations(protected, [pattern]))


if __name__ == "__main__":
    unittest.main()
