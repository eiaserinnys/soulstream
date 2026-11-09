#!/usr/bin/env python3
"""카드 #1111 restricted 통합 하네스의 fixture·프로세스 지원.

안전 규칙 2의 pid 규율이 이 파일 하나에 모여 있다. 하네스가 신호를 보내는
대상은 `OwnedChildren`에 등록된 자식뿐이고, 등록은 `Popen.pid`(int, >1)로만
한다. killpg는 `start_new_session=True`로 만든 그룹에만 쓴다.

비밀값은 읽어도 출력하지 않는다. 호스트 파일 지문은 크기·mtime·sha256만
남기고 내용은 담지 않는다.
"""

from __future__ import annotations

import hashlib
import json
import os
import select
import shutil
import signal
import socket
import subprocess
import time
import uuid
from pathlib import Path

GIT = "/usr/bin/git"
BASE_ENV_ALLOWLIST = (
    "PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "TERM",
    "USER", "LOGNAME", "SHELL", "HOME", "TMPDIR", "XDG_RUNTIME_DIR",
    "NODE_NO_WARNINGS",
)


class HarnessError(RuntimeError):
    pass


class HarnessSafetyError(HarnessError):
    pass


class HarnessTimeout(HarnessError):
    pass


class OwnedChildren:
    """하네스가 직접 띄운 자식만 신호 대상으로 허용한다(#1102 재발 방지)."""

    def __init__(self) -> None:
        self._pids: set[int] = set()

    def register(self, pid: object) -> int:
        if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 1:
            raise HarnessSafetyError(f"refusing to register a non-harness pid: {pid!r}")
        self._pids.add(pid)
        return pid

    def assert_owned(self, pid: object) -> int:
        if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 1:
            raise HarnessSafetyError(f"refusing to signal a non-positive pid: {pid!r}")
        if pid not in self._pids:
            raise HarnessSafetyError(f"refusing to signal a pid this harness did not start: {pid}")
        return pid

    def forget(self, pid: int) -> None:
        self._pids.discard(pid)

    def kill(self, pid: object, sig: int = signal.SIGKILL) -> None:
        os.kill(self.assert_owned(pid), sig)

    def kill_group(self, pid: object, sig: int = signal.SIGKILL) -> None:
        target = self.assert_owned(pid)
        try:
            group = os.getpgid(target)
        except ProcessLookupError:
            return
        if group != target:
            raise HarnessSafetyError(
                f"refusing killpg: pid {target} is not a harness-created session leader"
            )
        os.killpg(group, sig)

    @property
    def pids(self) -> set[int]:
        return set(self._pids)


def curated_base_env(overrides: dict[str, str] | None = None) -> dict[str, str]:
    env = {key: os.environ[key] for key in BASE_ENV_ALLOWLIST if key in os.environ}
    env.setdefault("HOME", os.path.expanduser("~"))
    if overrides:
        env.update(overrides)
    return env


def driver_env() -> dict[str, str]:
    env = curated_base_env({"NODE_NO_WARNINGS": "1"})
    common = os.environ.get("AGENT_COMMON_FILES_DIR")
    if common:
        env["AGENT_COMMON_FILES_DIR"] = common
    return env


def git_run(cwd: str | Path, args: list[str], timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run(
        [GIT, "-C", str(cwd), *args],
        capture_output=True, text=True, timeout=timeout,
    )


def git_ok(cwd: str | Path, args: list[str], timeout: int = 120) -> str:
    result = git_run(cwd, args, timeout=timeout)
    if result.returncode != 0:
        raise HarnessError(f"git {' '.join(args)} failed: {result.stderr.strip()[:400]}")
    return result.stdout.strip()


def commit_all(repo: str | Path, message: str) -> str:
    git_ok(repo, ["add", "-A"])
    git_ok(
        repo,
        ["-c", "user.name=Isolation Harness", "-c", "user.email=harness@example.invalid",
         "commit", "-m", message],
    )
    return git_ok(repo, ["rev-parse", "HEAD"])


def sha256_file(path: str | Path, limit: int = 4 * 1024 * 1024) -> str | None:
    try:
        handle = open(path, "rb")
    except OSError:
        return None
    digest = hashlib.sha256()
    with handle:
        remaining = limit
        while remaining > 0:
            chunk = handle.read(min(65536, remaining))
            if not chunk:
                break
            digest.update(chunk)
            remaining -= len(chunk)
    return digest.hexdigest()


def file_fingerprint(path: str | Path) -> dict:
    """내용은 담지 않는다. 종류·크기·mtime·sha256만 남긴다."""
    try:
        info = os.lstat(path)
    except OSError as exc:
        return {"exists": False, "errno": exc.errno}
    facts: dict[str, object] = {
        "exists": True,
        "size": info.st_size,
        "mtime_ns": info.st_mtime_ns,
        "mode": oct(info.st_mode & 0o777),
    }
    if os.path.isfile(path) and not os.path.islink(path):
        facts["sha256"] = sha256_file(path)
    return facts


def dir_listing(path: str | Path, limit: int = 64) -> list[str]:
    try:
        return sorted(os.listdir(path))[:limit]
    except OSError as exc:
        return [f"errno:{exc.errno}"]


def list_processes() -> dict[int, dict]:
    """pid -> {ppid, starttime, comm}. 내용이 아니라 커널 표식만 읽는다."""
    processes: dict[int, dict] = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        pid = int(entry)
        try:
            with open(f"/proc/{pid}/stat", "rb") as handle:
                text = handle.read().decode("utf-8", "replace")
        except OSError:
            continue
        close = text.rfind(")")
        if close < 0:
            continue
        comm = text[text.find("(") + 1 : close]
        fields = text[close + 2 :].split()
        if len(fields) < 20:
            continue
        try:
            processes[pid] = {
                "ppid": int(fields[1]),
                "pgrp": int(fields[2]),
                "starttime": int(fields[19]),
                "comm": comm[:40],
            }
        except ValueError:
            continue
    return processes


def descendants(root_pid: int) -> list[dict]:
    processes = list_processes()
    root = processes.get(root_pid)
    if root is None:
        return []
    found = []
    for pid, info in processes.items():
        if pid == root_pid:
            continue
        cursor = info
        for _ in range(64):
            parent = cursor["ppid"]
            if parent == root_pid:
                found.append({"pid": pid, "comm": info["comm"], "starttime": info["starttime"]})
                break
            if parent <= 1 or parent not in processes:
                break
            cursor = processes[parent]
    return sorted(found, key=lambda item: item["pid"])


def pid_namespace_inode(path: str = "/proc/self/ns/pid") -> int:
    return os.stat(path).st_ino


def new_session_id(label: str) -> str:
    """canonical lowercase UUID. ssr1 자격증명 형식이 이 값을 요구한다."""
    return str(uuid.uuid5(uuid.UUID("11111111-2222-3333-4444-555555555555"), label))


class DummyListener:
    """승인된 로컬 MCP 대역. 백로그에 연결을 쌓아 두고 나중에 센다."""

    def __init__(self) -> None:
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(16)
        self.port: int = self.sock.getsockname()[1]

    def accepted(self, timeout: float = 0.5) -> int:
        count = 0
        self.sock.settimeout(timeout)
        while True:
            try:
                connection, _ = self.sock.accept()
            except (socket.timeout, OSError):
                break
            connection.close()
            count += 1
        return count

    def close(self) -> None:
        self.sock.close()


def free_port() -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]
    finally:
        sock.close()


def build_fixture(run_root: Path) -> dict:
    """시험용 workspace와 git worktree, 원격, 캐시 프로젝트를 만든다."""
    ws = run_root / "ws"
    for relative in (".local/tmp", ".local/artifacts", ".local/incoming", ".local/index"):
        (ws / relative).mkdir(parents=True, exist_ok=True)
    (ws / "README.txt").write_text("harness fixture workspace\n", encoding="utf-8")
    (ws / ".local/index/inside.txt").write_text("harness index\n", encoding="utf-8")
    (ws / ".local/incoming/received.txt").write_text("harness incoming\n", encoding="utf-8")
    (ws / ".local/tmp/write-target.txt").write_text("harness tmp\n", encoding="utf-8")
    link = ws / ".local/tmp/link-to-etc-hostname"
    if not link.exists():
        link.symlink_to("/etc/hostname")

    projects = ws / ".projects"
    projects.mkdir(exist_ok=True)
    repo = projects / "repo-a"
    git_ok(run_root, ["init", "-b", "main", str(repo)])
    (repo / "a.txt").write_text("harness a\n", encoding="utf-8")
    commit_all(repo, "harness initial")
    owned = projects / "repo-a--owned"
    attached = projects / "repo-a--attached"
    neighbor = projects / "repo-a--neighbor"
    for path, branch in ((owned, "harness-owned"), (attached, "harness-attached"),
                         (neighbor, "harness-neighbor")):
        git_ok(repo, ["worktree", "add", str(path), "-b", branch])
        (path / f"{branch}.txt").write_text(f"{branch}\n", encoding="utf-8")
        commit_all(path, f"harness {branch}")
    git_ok(repo, ["pack-refs", "--all"])

    remotes = ws / ".local/tmp/remotes"
    remotes.mkdir(parents=True, exist_ok=True)
    bare = remotes / "repo-a.git"
    git_ok(run_root, ["clone", "--bare", str(repo), str(bare)])
    git_ok(bare, ["branch", "stale/one", "main"])

    cache_a = ws / ".local/tmp/cacheproj-a"
    cache_b = ws / ".local/tmp/cacheproj-b"
    cache_a.mkdir(exist_ok=True)
    cache_b.mkdir(exist_ok=True)
    (cache_a / "package.json").write_text(json.dumps(
        {"name": "cacheproj-a", "private": True, "version": "0.0.0"}), encoding="utf-8")
    (cache_b / "package.json").write_text(json.dumps({
        "name": "cacheproj-b", "private": True, "version": "0.0.0",
        "dependencies": {"is-number": "7.0.0"},
    }), encoding="utf-8")

    # runner socket 경로 상한(107바이트) 때문에 run_root 아래 긴 경로는 쓸 수
    # 없다. run_root의 부모에 짧은 이름으로 둔다(예: .../.local/tmp/card1111-rs-<hex6>).
    runner_state = run_root.parent.parent / ("card1111-rs-" + run_root.name[-6:])
    runner_state.mkdir(exist_ok=True)
    sibling = runner_state / new_session_id("sibling-session")
    sibling.mkdir(exist_ok=True)
    (sibling / "runner.json").write_text('{"harness":"sibling"}\n', encoding="utf-8")

    return {
        "run_root": run_root,
        "ws": ws,
        "repo": repo,
        "common_dir": repo / ".git",
        "owned": owned,
        "attached": attached,
        "neighbor": neighbor,
        "bare": bare,
        "cache_a": cache_a,
        "cache_b": cache_b,
        "runner_state": runner_state,
        "sibling_session": sibling,
    }


def write_job(path: Path, job: dict) -> Path:
    path.write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


class DriverRun:
    """드라이버(tsx) 프로세스 하나. 신호는 등록된 pid에만 보낸다."""

    def __init__(
        self,
        *,
        command: list[str],
        cwd: str,
        env: dict[str, str],
        stderr_path: Path,
        registry: OwnedChildren,
    ) -> None:
        self.registry = registry
        self._stderr_handle = open(stderr_path, "wb")
        self.proc = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=self._stderr_handle,
            bufsize=0,
            start_new_session=True,
        )
        self.pid = registry.register(self.proc.pid)
        assert self.proc.stdout is not None
        self._fd = self.proc.stdout.fileno()
        os.set_blocking(self._fd, False)
        self._buffer = b""
        self.lines: list[str] = []
        self.eof = False
        self.returncode: int | None = None
        self.stderr_path = stderr_path

    def _record(self, raw: bytes) -> None:
        text = raw.decode("utf-8", "replace").rstrip("\r")
        if text:
            self.lines.append(text)

    def pump(self, timeout: float) -> None:
        if self.eof:
            return
        try:
            ready, _, _ = select.select([self._fd], [], [], max(0.0, timeout))
        except (OSError, ValueError):
            self.eof = True
            return
        if not ready:
            return
        for _ in range(64):
            try:
                chunk = os.read(self._fd, 65536)
            except BlockingIOError:
                break
            except OSError:
                self.eof = True
                break
            if not chunk:
                self.eof = True
                break
            self._buffer += chunk
            while b"\n" in self._buffer:
                line, self._buffer = self._buffer.split(b"\n", 1)
                self._record(line)
            if len(chunk) < 65536:
                break

    def events(self, name: str | None = None) -> list[dict]:
        found = []
        for line in self.lines:
            if not line.startswith("HARNESS "):
                continue
            try:
                data = json.loads(line[len("HARNESS "):])
            except ValueError:
                continue
            if name is None or data.get("event") == name:
                found.append(data)
        return found

    def payload(self) -> list[dict]:
        found = []
        for line in self.lines:
            if not line.startswith("PAYLOAD_JSON:"):
                continue
            try:
                found.append(json.loads(line.split(":", 1)[1].strip()))
            except ValueError:
                found.append({"event": "unparsable"})
        return found

    def wait_for(self, name: str, timeout: float) -> dict | None:
        deadline = time.monotonic() + timeout
        while True:
            found = self.events(name)
            if found:
                return found[-1]
            if self.proc.poll() is not None and self.eof:
                return None
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            self.pump(min(0.5, remaining))

    def wait_exit(self, timeout: float) -> int | None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump(min(0.5, max(0.01, deadline - time.monotonic())))
            if self.proc.poll() is not None and self.eof:
                break
        self.pump(0.05)
        self.returncode = self.proc.poll()
        return self.returncode

    def terminate_owned(self, sig: int = signal.SIGTERM) -> None:
        self.registry.kill(self.pid, sig)

    def kill_owned(self, sig: int = signal.SIGKILL) -> None:
        self.registry.kill(self.pid, sig)

    def stderr_tail(self, limit: int = 400) -> str:
        self._stderr_handle.flush()
        try:
            text = self.stderr_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""
        return text.strip().splitlines()[-3:] and text.strip()[-limit:] or ""

    def close(self) -> None:
        self.registry.forget(self.pid)
        try:
            if self.proc.stdout is not None:
                self.proc.stdout.close()
        except OSError:
            pass
        self._stderr_handle.close()


def run_driver(
    *,
    command: list[str],
    cwd: str,
    env: dict[str, str],
    stderr_path: Path,
    registry: OwnedChildren,
    timeout: float,
) -> DriverRun:
    run = DriverRun(
        command=command, cwd=cwd, env=env, stderr_path=stderr_path, registry=registry,
    )
    run.wait_exit(timeout)
    return run


def cleanup_tree(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)
