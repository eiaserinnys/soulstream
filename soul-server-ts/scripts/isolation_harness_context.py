#!/usr/bin/env python3
"""카드 #1111 하네스의 실행 문맥·공통 헬퍼.

`verify-session-isolation.py`가 CLI·안전 규칙·실행 루프를 맡고, 축 함수는
`isolation_harness_axes.py`에 있다. 이 파일은 그 둘이 공유하는 상수와
job 생성·프로세스 회수·판정 도구를 담는다.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

from isolation_harness_fixture import (
    DummyListener,
    DriverRun,
    HarnessSafetyError,
    OwnedChildren,
    build_fixture,
    cleanup_tree,
    curated_base_env,
    descendants,
    dir_listing,
    file_fingerprint,
    free_port,
    git_run,
    list_processes,
    new_session_id,
    pid_namespace_inode,
    write_job,
)

SCRIPTS = Path(__file__).resolve().parent
SOUL_SERVER = SCRIPTS.parent
WORKTREE = SOUL_SERVER.parent
NODE = shutil.which("node") or "/usr/bin/node"
# .bin/tsx는 node를 spawn하는 런처라 하네스가 띄운 pid가 실제 드라이버가 아니다.
# `node --import <tsx 로더>`로 띄워 Popen.pid == launchIsolatedSession을 부른
# 프로세스가 되게 한다. 그래야 축 10의 「부모 종료」가 운영 형태 그대로다.
TSX_LOADER = SOUL_SERVER / "node_modules" / "tsx" / "dist" / "loader.mjs"
DRIVER = SCRIPTS / "isolation_harness_driver.ts"
PAYLOAD = SCRIPTS / "isolation_harness_payload.py"
SERVICE_DIR = "/home/eias/migration/netcup-core-bootstrap/production-staging/repo"
HOME = Path("/home/eias")
PROD = HOME / "migration" / "netcup-core-bootstrap"
REAL_PROJECTS = HOME / "workspace" / ".projects"
CACHE_ROOT = HOME / ".local/share/soulstream/isolated-cache"
PASTA = str(
    HOME / ".local/share/soulstream/isolation-tools/eiaserinnys/passt"
    "/0.0~git20250503.587980c-2+deb13u1/root/usr/bin/pasta"
)
HEAVY = os.path.join(
    os.environ.get("AGENT_COMMON_FILES_DIR", ""),
    "skills/heavy-work-verify/scripts/heavy_verify.py",
)
LOCK_PATHS = [f"/tmp/soulstream-heavy-verify{suffix}.lock"
              for suffix in ("", ".slot-1", ".slot-2", ".slot-3")]
MASKED = {
    "prod_state": PROD / "prod-state",
    "agent_common": PROD / "prod-state/agent-common-files",
    "prod_config": PROD / "production-staging/config",
    "prod_secrets": PROD / "production-staging/secrets",
    "prod_repo": PROD / "production-staging/repo",
    "prod_logs": PROD / "production-staging/logs",
    "codex_auth": HOME / ".codex/auth.json",
    "claude_creds": HOME / ".claude/.credentials.json",
    "pm2": HOME / ".pm2",
    "pm2_logs": HOME / ".pm2/logs",
}


def emit(kind: str, **data: object) -> None:
    print(f"{kind} {json.dumps(data, ensure_ascii=False, default=str)}", flush=True)


class Judge:
    """합격 조건 모음. 하나라도 어긋나면 fail이고 사유를 남긴다."""

    def __init__(self) -> None:
        self.failures: list[str] = []
        self.evidence: list[str] = []

    def check(self, ok: object, message: str) -> bool:
        if ok:
            self.evidence.append(message)
            return True
        self.failures.append(message)
        return False

    def note(self, message: str) -> None:
        self.evidence.append(message)


def host_facts() -> dict:
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("8.8.8.8", 53))
        address = probe.getsockname()[0]
    except OSError:
        address = "127.0.0.1"
    finally:
        probe.close()
    store = subprocess.run(["pnpm", "store", "path"], cwd=str(HOME),
                           capture_output=True, text=True, timeout=120)
    return {
        "uid": os.getuid(),
        "host_ip": address,
        "pidns_inode": pid_namespace_inode(),
        "main_store": store.stdout.strip() if store.returncode == 0 else "",
    }


def tree_fingerprint(path: Path) -> dict:
    facts = file_fingerprint(path)
    if path.is_dir():
        facts["entries"] = dir_listing(path, 32)
        facts["ino"] = os.stat(path).st_ino
    return facts


def driver_command(job_path: Path, heavy: bool, timeout: int) -> list[str]:
    command = [NODE, "--import", str(TSX_LOADER), str(DRIVER), str(job_path)]
    if heavy:
        return [sys.executable, HEAVY, "--timeout", str(timeout), "--", *command]
    return command


def start_job(ctx: dict, label: str, job: dict, timeout: int, heavy: bool = False) -> DriverRun:
    job_path = ctx["run_root"] / "jobs" / f"{label}.json"
    write_job(job_path, job)
    return DriverRun(
        command=driver_command(job_path, heavy, timeout),
        cwd=SERVICE_DIR,
        env=ctx["driver_env"],
        stderr_path=ctx["run_root"] / "logs" / f"{label}.err",
        registry=ctx["registry"],
    )


def finish_job(run: DriverRun, timeout: int) -> DriverRun:
    run.wait_exit(timeout)
    if run.returncode is None:
        run.kill_owned()
        run.wait_exit(10)
    return run


def isolation_facts(run: DriverRun) -> dict | None:
    for event in reversed(run.events()):
        if isinstance(event.get("isolation"), dict):
            return event["isolation"]
    return None


def payload_map(run: DriverRun) -> dict[str, dict]:
    return {entry.get("event"): entry for entry in run.payload()}


def failure_event(run: DriverRun) -> dict | None:
    for name in ("fatal", "ready_failed", "assembly_failed", "prepare_failed"):
        events = run.events(name)
        if events:
            return events[-1]
    return None


def group_members(pgid: int) -> list[int]:
    return sorted(pid for pid, info in list_processes().items() if info.get("pgrp") == pgid)


def wait_group_gone(pgid: int, timeout: float) -> list[int]:
    deadline = time.monotonic() + timeout
    members = group_members(pgid)
    while members and time.monotonic() < deadline:
        time.sleep(0.2)
        members = group_members(pgid)
    return members


def build_job(ctx: dict, sid: str, case: str, args: dict, **overrides: object) -> dict:
    fixture = ctx["fixture"]
    owned = str(fixture["owned"])
    job: dict = {
        "sessionId": sid,
        "backend": "opencode",
        "workspaceDir": str(fixture["ws"]),
        "hostWorkspaceRoot": str(fixture["ws"]),
        "runnerStateDir": str(fixture["runner_state"]),
        "projectsRoot": str(fixture["ws"] / ".projects"),
        "pastaPath": PASTA,
        "internalMcpPort": ctx["internal_port"],
        "localMcp": f"harness-approved:{ctx['listener'].port}",
        "hostBearerToken": "harness-synthetic-host-bearer",
        "registries": [{"repoId": "repo-a", "path": str(fixture["repo"])}],
        "worktrees": [
            {"worktreeId": "harness-owned", "repoId": "repo-a", "path": owned,
             "discoveryKind": "managed", "dbState": "ready",
             "ownerKind": "session", "ownerId": sid, "activeSessionId": None},
            {"worktreeId": "harness-attached", "repoId": "repo-a",
             "path": str(fixture["attached"]), "discoveryKind": "managed",
             "dbState": "ready", "ownerKind": "none", "ownerId": None,
             "activeSessionId": sid},
        ],
        "taskWorktreeId": "harness-owned",
        "mcpServers": ctx["mcp_servers"],
        "baseEnv": ctx["base_env"],
        "payload": {"program": sys.executable,
                    "args": [str(PAYLOAD), case, json.dumps(args, ensure_ascii=False)]},
    }
    job.update(overrides)
    return job


def probe_args(ctx: dict) -> dict:
    return {
        # SCRATCH_WORKSPACE_DIR는 운영 어댑터가 덮어쓰기 전의 부모 값이 그대로
        # 상자에 들어와야 한다(축 13 「기존 SCRATCH가 그대로」).
        "scratch_expected": ctx["base_env"].get("SCRATCH_WORKSPACE_DIR", ""),
        "store_expected": str(CACHE_ROOT / "pnpm-store"),
        "host_pidns_inode": ctx["host"]["pidns_inode"],
    }


def session_root(ctx: dict, sid: str) -> str:
    return str(ctx["fixture"]["ws"] / ".projects" / ".isolated" / sid)


def write_ops(ctx: dict, session_dir: str, sandbox_dir: str) -> list[dict]:
    ws = ctx["fixture"]["ws"]
    ops = [
        ("write_session_worktree", f"{session_dir}/harness-write.txt", "write"),
        ("write_local_tmp", f"{ws}/.local/tmp/harness-write.txt", "write"),
        ("write_local_artifacts", f"{ws}/.local/artifacts/harness-write.txt", "write"),
        ("write_cache", f"{CACHE_ROOT}/pnpm-store/harness-write.txt", "write"),
        ("write_sandbox", f"{sandbox_dir}/harness-write.txt", "write"),
        ("write_neighbor", f"{ws}/.projects/repo-a--neighbor/harness-write.txt", "write"),
        ("write_base_repo", f"{ws}/.projects/repo-a/harness-write.txt", "write"),
        ("write_local_index", f"{ws}/.local/index/harness-write.txt", "write"),
        ("write_local_incoming", f"{ws}/.local/incoming/harness-write.txt", "write"),
        ("write_prod_repo", f"{MASKED['prod_repo']}/harness-write.txt", "write"),
        ("write_prod_config", f"{MASKED['prod_config']}/harness-write.txt", "write"),
        ("read_prod_repo_package", f"{MASKED['prod_repo']}/package.json", "read"),
        ("read_tmp_symlink", f"{ws}/.local/tmp/link-to-etc-hostname", "read"),
        ("list_prod_config", str(MASKED["prod_config"]), "list"),
        ("list_prod_secrets", str(MASKED["prod_secrets"]), "list"),
        ("list_prod_state_runner", str(MASKED["prod_state"] / "runner"), "list"),
        ("list_agent_common", str(MASKED["agent_common"]), "list"),
        ("read_env_dotenv", f"{MASKED['prod_repo']}/.env.soul-server-ts", "read"),
        ("read_env_backup",
         f"{MASKED['prod_repo']}/.env.soul-server-ts.before-20261106-deepseek-1061", "read"),
        ("lstat_env_dotenv", f"{MASKED['prod_repo']}/.env.soul-server-ts", "lstat"),
        ("lstat_env_backup",
         f"{MASKED['prod_repo']}/.env.soul-server-ts.before-20261106-deepseek-1061", "lstat"),
        ("read_devnull", "/dev/null", "read"),
        ("lstat_devnull", "/dev/null", "lstat"),
        ("read_codex_auth", str(MASKED["codex_auth"]), "read"),
        ("read_claude_creds", str(MASKED["claude_creds"]), "read"),
        ("list_run_user", "/run/user/1000", "list"),
        ("lstat_docker_sock", "/run/docker.sock", "lstat"),
    ]
    dotenv = MASKED["prod_repo"] / ".env.soul-server-ts"
    if dotenv.is_symlink():
        ops.append(("read_env_dotenv_real", os.path.realpath(dotenv), "read"))
    return [{"id": ident, "path": path, "mode": mode} for ident, path, mode in ops]


def judge_files(judge: Judge, results: dict) -> None:
    for ident in ("write_session_worktree", "write_local_tmp", "write_local_artifacts",
                  "write_cache", "write_sandbox"):
        judge.check(results.get(ident, {}).get("ok") is True, f"{ident} 쓰기 성공")
    for ident in ("write_neighbor", "write_base_repo", "write_local_index",
                  "write_local_incoming", "write_prod_repo", "write_prod_config"):
        judge.check(results.get(ident, {}).get("ok") is False, f"{ident} 쓰기 거부")
    package = results.get("read_prod_repo_package", {})
    judge.check(package.get("ok") is True and package.get("bytes", 0) > 0,
                "prod repo 체크아웃 읽기 성공")
    symlink = results.get("read_tmp_symlink", {})
    judge.check(symlink.get("ok") is True and symlink.get("bytes", 0) > 0,
                ".local/tmp symlink 실경로 읽기 성공")
    for ident in ("list_prod_config", "list_prod_secrets", "list_run_user"):
        entry = results.get(ident, {})
        judge.check(entry.get("ok") is True and entry.get("count") == 0,
                    f"{ident} 가림(빈 디렉터리)")
    runner = results.get("list_prod_state_runner", {})
    judge.check(runner.get("ok") is False and runner.get("errno") == "ENOENT",
                "prod-state/runner mask 아래 미노출")
    common = results.get("list_agent_common", {})
    judge.check(common.get("ok") is True and common.get("count", 0) > 0,
                "agent-common-files RO 재노출")
    for ident in ("read_env_dotenv", "read_env_backup", "read_env_dotenv_real"):
        entry = results.get(ident)
        if entry is None:
            continue
        judge.check(entry.get("ok") is False or entry.get("bytes") == 0,
                    f"{ident} 가림(읽기 실패 또는 0바이트)")
    masked_env = [results.get(ident, {}) for ident in ("lstat_env_dotenv", "lstat_env_backup")]
    for entry in masked_env:
        judge.note(f".env 대체 파일 kind={entry.get('kind')} size={entry.get('size')} "
                   f"mode={entry.get('mode')} uid={entry.get('uid')}")
    devnull = results.get("read_devnull", {})
    judge.note(f"상자 /dev/null 읽기 {json.dumps(devnull, ensure_ascii=False)}")
    for ident in ("read_codex_auth", "read_claude_creds"):
        judge.check(results.get(ident, {}).get("ok") is False, f"{ident} 접근 거부")
    docker = results.get("lstat_docker_sock", {})
    judge.check(docker.get("ok") is True and docker.get("kind") == "other",
                "docker.sock은 /dev/null로 덮임(소켓 아님)")


def start_sentinel(ctx: dict) -> int:
    proc = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(300)"],
        env=ctx["driver_env"], stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return ctx["registry"].register(proc.pid)


def sentinel_alive(pid: int, starttime: int) -> bool:
    info = list_processes().get(pid)
    return info is not None and info.get("starttime") == starttime


__all__ = [
    "SCRIPTS", "SOUL_SERVER", "WORKTREE", "NODE", "TSX_LOADER", "DRIVER", "PAYLOAD",
    "SERVICE_DIR",
    "HOME", "PROD", "REAL_PROJECTS", "CACHE_ROOT", "PASTA", "HEAVY", "LOCK_PATHS",
    "MASKED", "DummyListener", "HarnessSafetyError", "descendants", "dir_listing",
    "emit", "Judge", "host_facts", "tree_fingerprint", "driver_command", "start_job",
    "finish_job", "isolation_facts", "payload_map", "failure_event", "group_members",
    "wait_group_gone", "build_job", "probe_args", "session_root", "write_ops",
    "judge_files", "start_sentinel", "sentinel_alive",
]
