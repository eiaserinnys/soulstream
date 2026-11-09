#!/usr/bin/env python3
"""카드 #1111 하네스의 실행 문맥·공통 헬퍼.

`verify-session-isolation.py`가 CLI·안전 규칙·실행 루프를 맡고, 축 함수는
`isolation_harness_axes.py`에 있다. 이 파일은 그 둘이 공유하는 상수와
job 생성·프로세스 회수·판정 도구를 담는다.
"""

from __future__ import annotations

import json
import hashlib
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
CLI_PATH = SCRIPTS / "verify-session-isolation.py"
SERVICE_DIR = "/home/eias/migration/netcup-core-bootstrap/production-staging/repo"
# 노드별 경로는 CLI(`--service-dir`, `--workspace`, `--pasta`)로 갈아 끼운다.
# 기본값은 eiaserinnys 값이고, HOME만 실행 사용자의 홈으로 따른다.
HOME = Path.home()
WORKSPACE = HOME / "workspace"
PROD = HOME / "migration" / "netcup-core-bootstrap"
REAL_PROJECTS = WORKSPACE / ".projects"
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
        self.unexecuted: list[str] = []

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


def tree_fingerprint(path: Path, limit: int | None = None) -> dict:
    facts = file_fingerprint(path)
    if path.is_dir():
        facts["ino"] = os.stat(path).st_ino
        files = []
        for root, dirs, names in os.walk(path):
            dirs.sort()
            for name in sorted(names):
                item = Path(root) / name
                if item.is_file() and not item.is_symlink():
                    files.append(item)
                    if limit is not None and len(files) == limit:
                        break
            if limit is not None and len(files) == limit:
                break
        samples = []
        for item in files:
            info = item.stat()
            digest = hashlib.sha256()
            with item.open("rb") as handle:
                for chunk in iter(lambda: handle.read(65536), b""):
                    digest.update(chunk)
            samples.append((str(item.relative_to(path)), info.st_ino, info.st_size,
                            info.st_mtime_ns, digest.hexdigest()))
        facts["files"] = samples
    return facts


def host_readable(op: dict) -> bool:
    """내용은 보존하거나 출력하지 않고 호스트의 존재·가독성만 확인한다."""
    path = op["path"]
    try:
        if op["mode"] == "list":
            with os.scandir(path):
                return True
        if op["mode"] == "lstat":
            os.lstat(path)
            return os.access(path, os.R_OK)
        with open(path, "rb") as handle:
            handle.read(1)
        return True
    except OSError:
        return False


def available_mask_ops(judge: Judge, ops: list[dict]) -> list[dict]:
    available = []
    for op in ops:
        host_op = ({"mode": "list", "path": str(Path(op["path"]).parent)}
                   if op["mode"] == "write" else op)
        if host_readable(host_op):
            available.append(op)
        else:
            judge.unexecuted.append(f"{op['id']}: not-executed (호스트 대상 부재 또는 읽기 불가)")
    return available


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
        cwd=ctx["service_dir"],
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
        "nodeId": ctx["node_id"],
        "workspaceDir": str(fixture["ws"]),
        "hostWorkspaceRoot": str(fixture["ws"]),
        "runnerStateDir": str(fixture["runner_state"]),
        "projectsRoot": str(fixture["ws"] / ".projects"),
        "pastaPath": ctx["pasta"],
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
        ("write_reexposed_log_dir", f"{MASKED['prod_config']}/logs/harness-write.txt", "write"),
        ("read_prod_repo_package", f"{MASKED['prod_repo']}/package.json", "read"),
        ("read_reexposed_log",
         f"{MASKED['prod_config']}/logs/soulstream-soul-server-ts.log", "read"),
        ("read_tmp_symlink", f"{ws}/.local/tmp/link-to-etc-hostname", "read"),
        ("list_prod_config", str(MASKED["prod_config"]), "list"),
        ("list_prod_secrets", str(MASKED["prod_secrets"]), "list"),
        ("list_prod_state_runner", str(MASKED["prod_state"] / "runner"), "list"),
        ("list_agent_common", str(MASKED["agent_common"]), "list"),
        ("list_rclone_config", str(HOME / ".config/rclone"), "list"),
        ("list_backups", str(HOME / "backups"), "list"),
        ("read_env_dotenv", f"{MASKED['prod_repo']}/.env.soul-server-ts", "read"),
        ("lstat_env_dotenv", f"{MASKED['prod_repo']}/.env.soul-server-ts", "lstat"),
        ("read_devnull", "/dev/null", "read"),
        ("lstat_devnull", "/dev/null", "lstat"),
        ("read_codex_auth", str(MASKED["codex_auth"]), "read"),
        ("read_claude_creds", str(MASKED["claude_creds"]), "read"),
        ("read_service_shared_env", str(HOME / "services/mcp-servers/shared/.env"), "read"),
        ("read_migration_orch_env", str(PROD / "config/orch.env"), "read"),
        ("read_vault_init", str(HOME / ".vault/init.txt"), "read"),
        ("read_workspace_env_local", str(WORKSPACE / ".env.local"), "read"),
        ("read_cron_jobs_env", str(HOME / "cron-jobs/.env"), "read"),
        ("list_run_user", "/run/user/1000", "list"),
        ("lstat_docker_sock", "/run/docker.sock", "lstat"),
    ]
    backups = sorted(MASKED["prod_repo"].glob(".env.soul-server-ts.before-*"))
    for index, backup in enumerate(backups):
        ops.extend([(f"read_env_backup_{index}", str(backup), "read"),
                    (f"lstat_env_backup_{index}", str(backup), "lstat")])
    if not backups:
        ops.append(("read_env_backup", str(MASKED["prod_repo"] / ".env.soul-server-ts.before-*"), "read"))
    dotenv = MASKED["prod_repo"] / ".env.soul-server-ts"
    if dotenv.is_symlink():
        ops.append(("read_env_dotenv_real", os.path.realpath(dotenv), "read"))
    return [{"id": ident, "path": path, "mode": mode} for ident, path, mode in ops]


def judge_files(judge: Judge, results: dict, ops: list[dict]) -> None:
    tested = {op["id"] for op in ops}
    for ident in ("write_session_worktree", "write_local_tmp", "write_local_artifacts",
                  "write_cache", "write_sandbox"):
        if ident in tested:
            judge.check(results.get(ident, {}).get("ok") is True, f"{ident} 쓰기 성공")
    for ident in ("write_neighbor", "write_base_repo", "write_local_index",
                  "write_local_incoming", "write_prod_repo", "write_prod_config"):
        if ident in tested:
            judge.check(results.get(ident, {}).get("ok") is False, f"{ident} 쓰기 거부")
    package = results.get("read_prod_repo_package", {})
    if "read_prod_repo_package" in tested:
        judge.check(package.get("ok") is True and package.get("bytes", 0) > 0,
                    "prod repo 체크아웃 읽기 성공")
    symlink = results.get("read_tmp_symlink", {})
    if "read_tmp_symlink" in tested:
        judge.check(symlink.get("ok") is True and symlink.get("bytes", 0) > 0,
                    ".local/tmp symlink 실경로 읽기 성공")
    reexposed = results.get("read_reexposed_log", {})
    for ident in ("list_prod_secrets", "list_run_user"):
        if ident not in tested:
            continue
        entry = results.get(ident, {})
        judge.check(entry.get("ok") is True and entry.get("count") == 0,
                    f"{ident} 가림(빈 디렉터리)")
    if "list_prod_config" in tested:
        # config/logs를 RO로 다시 열므로 config에는 logs 하나만 보인다.
        # 재노출 대상이 실행되지 않았으면 빈 디렉터리다.
        expected = 1 if reexposed.get("ok") is True else 0
        entry = results.get("list_prod_config", {})
        judge.check(entry.get("ok") is True and entry.get("count") == expected,
                    f"list_prod_config 가림(기대 {expected}개)")
    runner = results.get("list_prod_state_runner", {})
    if "list_prod_state_runner" in tested:
        judge.check(runner.get("ok") is False and runner.get("errno") == "ENOENT",
                    "prod-state/runner mask 아래 미노출")
    common = results.get("list_agent_common", {})
    if "list_agent_common" in tested:
        judge.check(common.get("ok") is True and common.get("count", 0) > 0,
                    "agent-common-files RO 재노출")
    for ident in ("read_service_shared_env", "read_migration_orch_env", "read_vault_init",
                  "read_workspace_env_local", "read_cron_jobs_env"):
        if ident not in tested:
            continue
        entry = results.get(ident, {})
        judge.check(entry.get("ok") is False or entry.get("bytes") == 0,
                    f"{ident} 가림(읽기 실패 또는 0바이트)")
    for ident in ("list_rclone_config", "list_backups"):
        if ident not in tested:
            continue
        entry = results.get(ident, {})
        judge.check(entry.get("ok") is True and entry.get("count") == 0,
                    f"{ident} 가림(빈 디렉터리)")
    if "read_reexposed_log" in tested:
        judge.check(reexposed.get("ok") is True and reexposed.get("bytes", 0) > 0,
                    "서비스 로그 RO 재노출(읽기 성공)")
    reexposed_write = results.get("write_reexposed_log_dir", {})
    if "write_reexposed_log_dir" in tested:
        judge.check(reexposed_write.get("ok") is False
                    and reexposed_write.get("errno") == "EROFS",
                    "서비스 로그 디렉터리 쓰기 거부(EROFS)")
    for ident in (op["id"] for op in ops if op["id"].startswith("read_env_")):
        entry = results.get(ident)
        if entry is None:
            continue
        judge.check(entry.get("ok") is False or entry.get("bytes") == 0,
                    f"{ident} 가림(읽기 실패 또는 0바이트)")
    masked_env = [results.get(op["id"], {}) for op in ops
                  if op["id"].startswith("lstat_env_")]
    for entry in masked_env:
        judge.note(f".env 대체 파일 kind={entry.get('kind')} size={entry.get('size')} "
                   f"mode={entry.get('mode')} uid={entry.get('uid')}")
    devnull = results.get("read_devnull", {})
    judge.note(f"상자 /dev/null 읽기 {json.dumps(devnull, ensure_ascii=False)}")
    for ident in ("read_codex_auth", "read_claude_creds"):
        if ident in tested:
            judge.check(results.get(ident, {}).get("ok") is False, f"{ident} 접근 거부")
    docker = results.get("lstat_docker_sock", {})
    if "lstat_docker_sock" in tested:
        judge.check(docker.get("ok") is True and docker.get("kind") == "other",
                    "docker.sock은 /dev/null로 덮임(소켓 아님)")


def start_sentinel(ctx: dict) -> int:
    proc = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(300)"],
        env=ctx["driver_env"], stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return ctx["registry"].register(proc)


def sentinel_alive(pid: int, starttime: int) -> bool:
    info = list_processes().get(pid)
    return info is not None and info.get("starttime") == starttime


__all__ = [
    "SCRIPTS", "SOUL_SERVER", "WORKTREE", "NODE", "TSX_LOADER", "DRIVER", "PAYLOAD",
    "CLI_PATH",
    "SERVICE_DIR", "WORKSPACE",
    "HOME", "PROD", "REAL_PROJECTS", "CACHE_ROOT", "PASTA", "HEAVY", "LOCK_PATHS",
    "MASKED", "DummyListener", "HarnessSafetyError", "descendants", "dir_listing",
    "emit", "Judge", "host_facts", "tree_fingerprint", "driver_command", "start_job",
    "finish_job", "isolation_facts", "payload_map", "failure_event", "group_members",
    "wait_group_gone", "build_job", "probe_args", "session_root", "write_ops",
    "host_readable", "available_mask_ops",
    "judge_files", "start_sentinel", "sentinel_alive",
]
