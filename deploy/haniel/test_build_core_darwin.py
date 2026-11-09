"""Contract tests for the Darwin build runner used by deploy/haniel/build-core.sh."""

from __future__ import annotations

import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from deploy.haniel import build_core_darwin as build_core


VM_STAT_16384 = "\n".join([
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                              100000.",
    "Pages active:                            200000.",
    "Pages inactive:                           50000.",
    "Pages speculative:                        10000.",
    "Pages throttled:                              0.",
    "Pages wired down:                         80000.",
    "Pages purgeable:                          20000.",
    '"Translation faults":                   123456.',
])


class FakeProcess:
    def __init__(self, wait_results: list[object], pid: int = 4242) -> None:
        self.pid = pid
        self.wait_results = list(wait_results)
        self.wait_calls: list[float | None] = []

    def wait(self, timeout: float | None = None) -> int:
        self.wait_calls.append(timeout)
        result = self.wait_results.pop(0)
        if isinstance(result, BaseException):
            raise result
        return int(result)


class ParseVmStatTests(unittest.TestCase):
    def test_sums_free_inactive_and_purgeable_pages_in_mib(self) -> None:
        # (100000 + 50000 + 20000) * 16384 bytes = 2656 MiB after flooring.
        self.assertEqual(build_core.parse_vm_stat_available_mib(VM_STAT_16384), 2656)

    def test_supports_4096_byte_pages_and_counts_without_trailing_dots(self) -> None:
        output = "\n".join([
            "Mach Virtual Memory Statistics: (page size of 4096 bytes)",
            "Pages free: 300000",
            "Pages inactive: 100000",
            "Pages purgeable: 50000",
        ])
        self.assertEqual(
            build_core.parse_vm_stat_available_mib(output),
            (300000 + 100000 + 50000) * 4096 // (1024 * 1024),
        )

    def test_returns_none_for_missing_or_malformed_input(self) -> None:
        self.assertIsNone(build_core.parse_vm_stat_available_mib(""))
        self.assertIsNone(build_core.parse_vm_stat_available_mib(
            "Pages free: 10.\nPages inactive: 20.\nPages purgeable: 5."
        ))
        self.assertIsNone(build_core.parse_vm_stat_available_mib(
            "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n"
            "Pages free: 10.\nPages inactive: 20."
        ))


class MemoryGateTests(unittest.TestCase):
    def test_accepts_sufficient_memory_without_waiting(self) -> None:
        sleeps: list[float] = []
        build_core.require_available_memory(read_available=lambda: 2000, sleep=sleeps.append)
        self.assertEqual(sleeps, [])

    def test_waits_once_then_runs_when_memory_recovers(self) -> None:
        readings = iter([1000, 3000])
        sleeps: list[float] = []
        build_core.require_available_memory(
            read_available=lambda: next(readings),
            sleep=sleeps.append,
        )
        self.assertEqual(sleeps, [60])

    def test_refuses_build_when_memory_stays_low(self) -> None:
        sleeps: list[float] = []
        with self.assertRaises(SystemExit) as context:
            build_core.require_available_memory(read_available=lambda: 1999, sleep=sleeps.append)
        self.assertEqual(context.exception.code, 1)
        self.assertEqual(sleeps, [60])

    def test_treats_unreadable_memory_as_insufficient(self) -> None:
        sleeps: list[float] = []
        with self.assertRaises(SystemExit) as context:
            build_core.require_available_memory(read_available=lambda: None, sleep=sleeps.append)
        self.assertEqual(context.exception.code, 1)
        self.assertEqual(sleeps, [60])


class BuildEnvironmentTests(unittest.TestCase):
    def test_sets_home_node_env_and_appends_existing_directories_once(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            home = Path(temporary_directory)
            (home / ".local" / "bin").mkdir(parents=True)
            environment = build_core.build_environment(
                base_env={"PATH": "/existing/bin:/usr/bin", "HOME": "/ignored"},
                home=home,
            )

        self.assertEqual(environment["HOME"], str(home))
        self.assertEqual(environment["NODE_ENV"], "production")
        self.assertEqual(environment["COREPACK_ENABLE_DOWNLOAD_PROMPT"], "0")
        entries = environment["PATH"].split(os.pathsep)
        self.assertEqual(entries[:2], ["/existing/bin", "/usr/bin"])
        self.assertIn(str(home / ".local" / "bin"), entries)
        self.assertNotIn(str(home / ".npm-global" / "bin"), entries)
        self.assertEqual(len(entries), len(set(entries)))


class BuildStepTests(unittest.TestCase):
    def test_declares_the_six_linux_hook_commands(self) -> None:
        app_dir = Path("/tmp/app")
        steps = build_core.build_steps(app_dir)

        self.assertEqual(len(steps), 6)
        self.assertEqual(steps[0], ["corepack", "pnpm", "install", "--frozen-lockfile", "--prod=false"])
        self.assertEqual(
            steps[1],
            [
                "corepack",
                "pnpm",
                "--filter",
                "@soulstream/soul-server-ts",
                "exec",
                "env",
                "SOULSTREAM_RELEASE_ENV_FILE=/tmp/app/.env.soul-server-ts",
                "pnpm",
                "run",
                "build",
            ],
        )
        self.assertEqual(
            steps[2],
            ["corepack", "pnpm", "--filter", "@soulstream/orch-server-ts", "run", "build"],
        )
        self.assertEqual(
            steps[3],
            ["corepack", "pnpm", "--dir", "/tmp/app/unified-dashboard", "run", "build"],
        )
        self.assertEqual(
            steps[4],
            ["npm", "--prefix", "/tmp/app/soul-app", "ci", "--include=dev", "--no-audit", "--no-fund"],
        )
        self.assertEqual(
            steps[5],
            ["npm", "--prefix", "/tmp/app/soul-app", "run", "export:components"],
        )

    def test_build_core_script_dispatches_to_darwin_before_realpath(self) -> None:
        script = (REPOSITORY_ROOT / "deploy" / "haniel" / "build-core.sh").read_text(encoding="utf-8")
        self.assertIn("build_core_darwin.py", script)
        realpath_call = 'realpath -- "${BASH_SOURCE[0]}"'
        self.assertIn(realpath_call, script)
        self.assertLess(script.index("uname -s"), script.index(realpath_call))


class RunStepTests(unittest.TestCase):
    def test_runs_command_in_the_app_directory_with_new_session(self) -> None:
        process = FakeProcess([0])
        popen_calls: list[dict[str, object]] = []

        def fake_popen(argv: list[str], **kwargs: object) -> FakeProcess:
            popen_calls.append({"argv": argv, **kwargs})
            return process

        returncode = build_core.run_step(
            ["corepack", "pnpm", "install"],
            app_dir=Path("/tmp/app"),
            env={"PATH": "/usr/bin"},
            popen=fake_popen,
        )

        self.assertEqual(returncode, 0)
        self.assertEqual(popen_calls[0]["argv"], ["corepack", "pnpm", "install"])
        self.assertEqual(popen_calls[0]["cwd"], "/tmp/app")
        self.assertEqual(popen_calls[0]["env"], {"PATH": "/usr/bin"})
        self.assertTrue(popen_calls[0]["start_new_session"])
        self.assertEqual(process.wait_calls, [build_core.STEP_TIMEOUT_SECONDS])

    def test_returns_the_command_exit_code(self) -> None:
        process = FakeProcess([7])
        returncode = build_core.run_step(["/bin/false"], popen=lambda *args, **kwargs: process)
        self.assertEqual(returncode, 7)

    def test_timeout_cleans_the_process_group_and_returns_124(self) -> None:
        process = FakeProcess([subprocess.TimeoutExpired(cmd="build", timeout=900)])

        with mock.patch.object(build_core, "terminate_build_process") as terminate:
            returncode = build_core.run_step(
                ["corepack", "pnpm", "install"],
                popen=lambda *args, **kwargs: process,
            )

        self.assertEqual(returncode, 124)
        terminate.assert_called_once_with(process)


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


class TerminateBuildProcessTests(unittest.TestCase):
    def test_sends_sigterm_then_sigkill_when_the_parent_ignores_sigterm(self) -> None:
        process = FakeProcess([
            subprocess.TimeoutExpired(cmd="build", timeout=2),
            0,
        ])
        signals: list[tuple[int, int]] = []
        clock = FakeClock()

        build_core.terminate_build_process(
            process,
            kill_group=lambda pid, signum: signals.append((pid, signum)),
            sleep=clock.sleep,
            clock=clock,
        )

        self.assertEqual(signals, [(4242, build_core.signal.SIGTERM), (4242, build_core.signal.SIGKILL)])
        self.assertEqual(process.wait_calls, [build_core.TERMINATION_GRACE_SECONDS] * 2)

    def test_kills_the_group_when_the_parent_exits_but_children_remain(self) -> None:
        process = FakeProcess([0])
        signals: list[tuple[int, int]] = []
        clock = FakeClock()

        build_core.terminate_build_process(
            process,
            kill_group=lambda pid, signum: signals.append((pid, signum)),
            sleep=clock.sleep,
            clock=clock,
        )

        real_signals = [call for call in signals if call[1] != 0]
        self.assertEqual(real_signals, [(4242, build_core.signal.SIGTERM), (4242, build_core.signal.SIGKILL)])
        self.assertTrue(any(call[1] == 0 for call in signals))
        self.assertGreaterEqual(clock.now, build_core.TERMINATION_GRACE_SECONDS)
        self.assertEqual(process.wait_calls, [build_core.TERMINATION_GRACE_SECONDS])

    def test_stops_after_sigterm_when_the_group_is_gone(self) -> None:
        process = FakeProcess([0])
        signals: list[tuple[int, int]] = []
        clock = FakeClock()

        def kill_group(pid: int, signum: int) -> None:
            if signum == 0:
                raise ProcessLookupError
            signals.append((pid, signum))

        build_core.terminate_build_process(
            process,
            kill_group=kill_group,
            sleep=clock.sleep,
            clock=clock,
        )

        self.assertEqual(signals, [(4242, build_core.signal.SIGTERM)])
        self.assertEqual(process.wait_calls, [build_core.TERMINATION_GRACE_SECONDS])
        self.assertEqual(clock.now, 0.0)

    def test_ignores_a_process_group_that_already_exited(self) -> None:
        def missing_group(pid: int, signum: int) -> None:
            raise ProcessLookupError

        process = FakeProcess([0])
        build_core.terminate_build_process(process, kill_group=missing_group)
        self.assertEqual(process.wait_calls, [build_core.TERMINATION_GRACE_SECONDS])


class ArtifactTests(unittest.TestCase):
    def test_requires_all_five_build_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            app_dir = Path(temporary_directory)
            for relative in build_core.BUILD_ARTIFACTS:
                artifact = app_dir / relative
                artifact.parent.mkdir(parents=True, exist_ok=True)
                artifact.write_text("artifact", encoding="utf-8")

            build_core.verify_build_artifacts(app_dir)

            (app_dir / build_core.BUILD_ARTIFACTS[0]).unlink()
            with self.assertRaises(SystemExit) as context:
                build_core.verify_build_artifacts(app_dir)
            self.assertEqual(context.exception.code, 1)


class RunBuildTests(unittest.TestCase):
    def test_runs_every_step_in_order_and_keeps_the_lock_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            app_dir = Path(temporary_directory)
            lock_path = app_dir / "build.lock"
            calls: list[tuple[list[str], Path, dict[str, str]]] = []
            verified: list[Path] = []

            def fake_run(argv, *, app_dir, env):
                calls.append((list(argv), app_dir, dict(env)))
                return 0

            returncode = build_core.run_build(
                app_dir=app_dir,
                lock_path=lock_path,
                read_available=lambda: 5000,
                sleep=lambda seconds: None,
                run=fake_run,
                steps=[["first"], ["second"]],
                verify_artifacts=verified.append,
            )

            self.assertEqual(returncode, 0)
            self.assertEqual([call[0] for call in calls], [["first"], ["second"]])
            self.assertEqual(calls[0][1], app_dir)
            self.assertEqual(calls[0][2]["NODE_ENV"], "production")
            self.assertEqual(verified, [app_dir])
            self.assertTrue(lock_path.exists())
            self.assertEqual(stat.S_IMODE(lock_path.stat().st_mode), 0o600)

    def test_stops_after_a_failing_step(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            app_dir = Path(temporary_directory)
            calls: list[list[str]] = []
            returncodes = iter([0, 3, 0])

            def fake_run(argv, *, app_dir, env):
                calls.append(list(argv))
                return next(returncodes)

            returncode = build_core.run_build(
                app_dir=app_dir,
                lock_path=app_dir / "build.lock",
                read_available=lambda: 5000,
                sleep=lambda seconds: None,
                run=fake_run,
                steps=[["first"], ["second"], ["third"]],
                verify_artifacts=lambda path: self.fail("artifacts must not be checked after a failure"),
            )

            self.assertEqual(returncode, 3)
            self.assertEqual(calls, [["first"], ["second"]])

    def test_refuses_before_running_any_step_when_memory_stays_low(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            app_dir = Path(temporary_directory)

            with self.assertRaises(SystemExit) as context:
                build_core.run_build(
                    app_dir=app_dir,
                    lock_path=app_dir / "build.lock",
                    read_available=lambda: None,
                    sleep=lambda seconds: None,
                    run=lambda *args, **kwargs: self.fail("no step may run"),
                    steps=[["first"]],
                    verify_artifacts=lambda path: self.fail("no artifact check"),
                )

            self.assertEqual(context.exception.code, 1)


class ShellScriptSyntaxTests(unittest.TestCase):
    def test_shell_scripts_pass_bash_syntax_check(self) -> None:
        for relative in (
            "deploy/haniel/build-core.sh",
            "deploy/haniel/pack_portable_node_release.sh",
            "deploy/macos/check-macos-node.sh",
        ):
            completed = subprocess.run(
                ["bash", "-n", str(REPOSITORY_ROOT / relative)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, f"{relative}: {completed.stderr}")


if __name__ == "__main__":
    unittest.main()
