#!/usr/bin/env python3
"""Darwin build runner for the Haniel build hook.

`build-core.sh` execs this script on macOS because the Linux hook depends on GNU
`realpath`, `flock`, `free`, GNU `timeout` and a fixed `/home/eias` account.
This runner keeps the same six build commands, the same 2000 MiB memory gate,
the same host heavy-work lock and the same artifact checks using only the
Python standard library.
"""

from __future__ import annotations

import fcntl
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable, Mapping, Sequence

MINIMUM_AVAILABLE_MIB = 2000
MEMORY_WAIT_SECONDS = 60
STEP_TIMEOUT_SECONDS = 900
TERMINATION_GRACE_SECONDS = 2.0
LOCK_PATH = Path("/tmp/soulstream-heavy-verify.lock")
VM_STAT_PATH = "/usr/bin/vm_stat"

APP_DIR = Path(__file__).resolve().parents[2]

BUILD_ARTIFACTS = (
    "soul-server-ts/dist/main.js",
    "orch-server-ts/dist/production_main.js",
    "unified-dashboard/dist/index.html",
    "unified-dashboard/dist/build-info.json",
    "unified-dashboard/dist/assets/ios-components/index.html",
)

_PAGE_SIZE_PATTERN = re.compile(r"page size of (\d+) bytes")
_PAGE_COUNT_PATTERNS = (
    re.compile(r"^Pages free:[ \t]+(\d+)\.?[ \t]*$", re.MULTILINE),
    re.compile(r"^Pages inactive:[ \t]+(\d+)\.?[ \t]*$", re.MULTILINE),
    re.compile(r"^Pages purgeable:[ \t]+(\d+)\.?[ \t]*$", re.MULTILINE),
)


class BuildInterrupted(Exception):
    """Raised when the build runner receives SIGTERM or SIGINT."""

    def __init__(self, signum: int) -> None:
        super().__init__(f"build interrupted by signal {signum}")
        self.signum = signum


def parse_vm_stat_available_mib(output: str) -> int | None:
    """Returns free + inactive + purgeable memory in MiB, or None."""
    lines = output.splitlines()
    if not lines:
        return None
    page_size_match = _PAGE_SIZE_PATTERN.search(lines[0])
    if page_size_match is None:
        return None
    page_size = int(page_size_match.group(1))
    if page_size <= 0:
        return None

    page_count = 0
    for pattern in _PAGE_COUNT_PATTERNS:
        match = pattern.search(output)
        if match is None:
            return None
        page_count += int(match.group(1))
    return page_count * page_size // (1024 * 1024)


def read_available_memory_mib() -> int | None:
    try:
        completed = subprocess.run(
            [VM_STAT_PATH],
            capture_output=True,
            text=True,
            timeout=2,
            env={**os.environ, "LC_ALL": "C"},
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    return parse_vm_stat_available_mib(completed.stdout)


def require_available_memory(
    *,
    read_available: Callable[[], int | None] = read_available_memory_mib,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    available_mib = read_available()
    if available_mib is not None and available_mib >= MINIMUM_AVAILABLE_MIB:
        return

    print(
        f"Available memory is below {MINIMUM_AVAILABLE_MIB} MiB; "
        f"waiting {MEMORY_WAIT_SECONDS} seconds before retrying.",
        file=sys.stderr,
    )
    sleep(MEMORY_WAIT_SECONDS)
    available_mib = read_available()
    if available_mib is None or available_mib < MINIMUM_AVAILABLE_MIB:
        print(
            f"Refusing build: need at least {MINIMUM_AVAILABLE_MIB} MiB available memory.",
            file=sys.stderr,
        )
        raise SystemExit(1)


def build_environment(
    *,
    base_env: Mapping[str, str] | None = None,
    home: Path | None = None,
) -> dict[str, str]:
    environment = dict(os.environ if base_env is None else base_env)
    home_path = Path.home() if home is None else home
    environment["HOME"] = str(home_path)
    environment["NODE_ENV"] = "production"
    environment["COREPACK_ENABLE_DOWNLOAD_PROMPT"] = "0"

    path_entries = [entry for entry in environment.get("PATH", "").split(os.pathsep) if entry]
    extra_directories = [
        home_path / ".local" / "bin",
        home_path / ".npm-global" / "bin",
        Path("/opt/homebrew/bin"),
        Path("/usr/local/bin"),
        Path("/usr/bin"),
        Path("/bin"),
        Path("/usr/sbin"),
        Path("/sbin"),
    ]
    for directory in extra_directories:
        entry = str(directory)
        if directory.is_dir() and entry not in path_entries:
            path_entries.append(entry)
    environment["PATH"] = os.pathsep.join(path_entries)
    return environment


def build_steps(app_dir: Path = APP_DIR) -> list[list[str]]:
    return [
        ["corepack", "pnpm", "install", "--frozen-lockfile", "--prod=false"],
        [
            "corepack",
            "pnpm",
            "--filter",
            "@soulstream/soul-server-ts",
            "exec",
            "env",
            f"SOULSTREAM_RELEASE_ENV_FILE={app_dir / '.env.soul-server-ts'}",
            "pnpm",
            "run",
            "build",
        ],
        ["corepack", "pnpm", "--filter", "@soulstream/orch-server-ts", "run", "build"],
        ["corepack", "pnpm", "--dir", str(app_dir / "unified-dashboard"), "run", "build"],
        [
            "npm",
            "--prefix",
            str(app_dir / "soul-app"),
            "ci",
            "--include=dev",
            "--no-audit",
            "--no-fund",
        ],
        ["npm", "--prefix", str(app_dir / "soul-app"), "run", "export:components"],
    ]


def verify_build_artifacts(app_dir: Path = APP_DIR) -> None:
    missing = [relative for relative in BUILD_ARTIFACTS if not (app_dir / relative).is_file()]
    if not missing:
        return
    for relative in missing:
        print(f"Missing build artifact: {app_dir / relative}", file=sys.stderr)
    raise SystemExit(1)


def acquire_build_lock(lock_path: Path = LOCK_PATH) -> int:
    """Takes the host heavy-work lock and keeps it until the descriptor closes."""
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
    except BaseException:
        os.close(descriptor)
        raise
    return descriptor


def _wait_with_grace(process: subprocess.Popen, grace_seconds: float) -> bool:
    try:
        process.wait(timeout=grace_seconds)
    except subprocess.TimeoutExpired:
        return False
    return True


def terminate_build_process(
    process: subprocess.Popen,
    *,
    grace_seconds: float = TERMINATION_GRACE_SECONDS,
    kill_group: Callable[[int, int], None] = os.killpg,
) -> None:
    """Terminates the build's process group: SIGTERM, then SIGKILL after grace."""
    try:
        kill_group(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    if _wait_with_grace(process, grace_seconds):
        return
    try:
        kill_group(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    _wait_with_grace(process, grace_seconds)


def run_step(
    argv: Sequence[str],
    *,
    app_dir: Path = APP_DIR,
    env: Mapping[str, str] | None = None,
    timeout: float = STEP_TIMEOUT_SECONDS,
    popen: Callable[..., subprocess.Popen] = subprocess.Popen,
) -> int:
    process = popen(
        list(argv),
        cwd=str(app_dir),
        env=dict(env) if env is not None else None,
        start_new_session=True,
    )

    def handle_signal(signum, _frame) -> None:
        raise BuildInterrupted(signum)

    previous_handlers = {}
    for handled_signal in (signal.SIGTERM, signal.SIGINT):
        previous_handlers[handled_signal] = signal.signal(handled_signal, handle_signal)
    try:
        try:
            return process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            terminate_build_process(process)
            return 124
        except BuildInterrupted:
            terminate_build_process(process)
            raise
    finally:
        for handled_signal, handler in previous_handlers.items():
            signal.signal(handled_signal, handler)


def run_build(
    *,
    app_dir: Path = APP_DIR,
    lock_path: Path = LOCK_PATH,
    read_available: Callable[[], int | None] = read_available_memory_mib,
    sleep: Callable[[float], None] = time.sleep,
    run: Callable[..., int] = run_step,
    steps: Sequence[Sequence[str]] | None = None,
    verify_artifacts: Callable[[Path], None] = verify_build_artifacts,
) -> int:
    environment = build_environment()
    commands = [list(step) for step in (steps if steps is not None else build_steps(app_dir))]
    lock_descriptor = acquire_build_lock(lock_path)
    try:
        for command in commands:
            require_available_memory(read_available=read_available, sleep=sleep)
            returncode = run(command, app_dir=app_dir, env=environment)
            if returncode != 0:
                print(
                    f"Build command failed with exit code {returncode}: {' '.join(command)}",
                    file=sys.stderr,
                )
                return returncode
        verify_artifacts(app_dir)
        return 0
    finally:
        os.close(lock_descriptor)


def main(argv: Sequence[str] | None = None) -> int:
    del argv
    try:
        return run_build()
    except BuildInterrupted as interrupted:
        return 128 + interrupted.signum


if __name__ == "__main__":
    sys.exit(main())
