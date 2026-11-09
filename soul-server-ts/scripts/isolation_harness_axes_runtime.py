#!/usr/bin/env python3
"""카드 #1111 하네스 축 9~15: gh·종료 회수·heavy lock·관측·로컬 mask·인증·준비 시간."""

from __future__ import annotations

import json
import os
import signal
import time

from isolation_harness_context import (
    HOME,
    LOCK_PATHS,
    MASKED,
    REAL_PROJECTS,
    Judge,
    available_mask_ops,
    build_job,
    descendants,
    dir_listing,
    file_fingerprint,
    finish_job,
    git_run,
    isolation_facts,
    new_session_id,
    payload_map,
    probe_args,
    start_job,
    start_sentinel,
    sentinel_alive,
    tree_fingerprint,
)
from isolation_harness_fixture import list_processes


def axis_gh(ctx: dict) -> dict:
    judge = Judge()
    gh_dir = HOME / ".config/gh"
    before = {name: tree_fingerprint(gh_dir / name)
              for name in ("hosts.yml", "config.yml")}
    run = finish_job(start_job(ctx, "axis9", build_job(
        ctx, new_session_id("axis9-gh"), "gh", {}), 240), 240)
    child = (isolation_facts(run) or {}).get("childEnv", {})
    event = payload_map(run).get("gh_api_user", {})
    if child.get("ghTokenPresent") is not True:
        return {"status": "not-executed",
                "evidence": "운영 코드가 GH_TOKEN을 공급하지 않아 미실행",
                "failures": [], "details": {"childEnv": child}}
    judge.check(event.get("rc") == 0 and event.get("login_present") is True,
                "gh api user 성공")
    after = {name: tree_fingerprint(gh_dir / name) for name in before}
    for name in ("hosts.yml", "config.yml"):
        judge.check(before[name] == after[name], f"호스트 ~/.config/gh/{name} 불변")
    return {"status": "fail" if judge.failures else "pass",
            "evidence": "; ".join(judge.evidence), "failures": judge.failures,
            "details": {"gh": event, "ghConfigDir": child.get("ghConfigDir")}}


def ready_identities(run, judge: Judge, label: str) -> list[dict]:
    ready = run.wait_for("ready", 120)
    payload_ready = run.wait_payload("ready", 120) if ready else None
    recorded = descendants(run.pid) if payload_ready else []
    helper = (ready or {}).get("helperPid")
    roles = {"helper": [], "pasta": [], "bwrap": [], "payload": []}
    for entry in recorded:
        pid, comm = entry["pid"], entry["comm"]
        if pid == helper:
            roles["helper"].append(pid)
        if comm.startswith("pasta"):
            roles["pasta"].append(pid)
        if comm.startswith("bwrap"):
            roles["bwrap"].append(pid)
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as handle:
                is_payload = b"isolation_harness_payload.py" in handle.read()
        except OSError:
            is_payload = False
        if is_payload:
            roles["payload"].append(pid)
    judge.check(ready is not None and payload_ready is not None,
                f"{label}: helper와 payload ready")
    for role, pids in roles.items():
        judge.check(bool(pids), f"{label}: {role} identity 기록")
    return recorded


def wait_identities_gone(recorded: list[dict], timeout: float) -> list[dict]:
    deadline = time.monotonic() + timeout
    while True:
        processes = list_processes()
        alive = [entry for entry in recorded
                 if processes.get(entry["pid"], {}).get("starttime") == entry["starttime"]]
        if not alive or time.monotonic() >= deadline:
            return alive
        time.sleep(0.2)


def axis_termination(ctx: dict) -> dict:
    judge = Judge()
    sentinel = start_sentinel(ctx)
    sentinel_start = list_processes()[sentinel]["starttime"]
    identities: dict[str, list[dict]] = {}
    survivors: dict[str, list[dict]] = {}
    try:
        normal = start_job(ctx, "axis10-normal", build_job(
            ctx, new_session_id("axis10-normal"), "sleep", {"seconds": 6}), 240)
        identities["normal"] = ready_identities(normal, judge, "normal")
        finish_job(normal, 240)
        exit_event = (normal.events("exit") or [{}])[-1]
        judge.check(exit_event.get("code") == 0, "정상 종료 exit code 0")
        survivors["normal"] = wait_identities_gone(identities["normal"], 15)
        judge.check(not survivors["normal"], "정상 종료 뒤 기록된 자손 회수")
        judge.check(sentinel_alive(sentinel, sentinel_start), "정상 종료 뒤 sentinel 생존")

        abort = start_job(ctx, "axis10-abort", build_job(
            ctx, new_session_id("axis10-abort"), "sleep", {}, abortAfterMs=4000), 240)
        identities["abort"] = ready_identities(abort, judge, "abort")
        finish_job(abort, 240)
        judge.check(bool(abort.events("abort")), "abort 전달")
        survivors["abort"] = wait_identities_gone(identities["abort"], 15)
        judge.check(not survivors["abort"], "abort 뒤 기록된 자손 회수")
        judge.check(sentinel_alive(sentinel, sentinel_start), "abort 뒤 sentinel 생존")

        parent = start_job(ctx, "axis10-parent", build_job(
            ctx, new_session_id("axis10-parent"), "sleep", {}), 240)
        identities["parent"] = ready_identities(parent, judge, "parent")
        parent.kill_owned(signal.SIGKILL)
        parent.wait_exit(15)
        survivors["parent"] = wait_identities_gone(identities["parent"], 20)
        judge.check(not survivors["parent"], "드라이버 사망 뒤 기록된 자손 회수")
        judge.check(sentinel_alive(sentinel, sentinel_start), "부모 종료 뒤 sentinel 생존")
    finally:
        try:
            ctx["registry"].kill(sentinel, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return {"status": "fail" if judge.failures else "pass",
            "evidence": "; ".join(judge.evidence), "failures": judge.failures,
            "details": {"sentinel": sentinel, "identities": identities,
                        "survivors": survivors}}


def axis_heavy_work(ctx: dict) -> dict:
    judge = Judge()
    sid = new_session_id("axis11-heavy")
    run = finish_job(start_job(ctx, "axis11", build_job(
        ctx, sid, "locks", {"paths": LOCK_PATHS}), 240), 240)
    event = payload_map(run).get("locks", {})
    files = event.get("files", {})
    for path in LOCK_PATHS:
        entry = files.get(path, {})
        judge.check(entry.get("exists") is True and entry.get("regular") is True,
                    f"{os.path.basename(path)} 보임")
        judge.check(entry.get("mode") == "0o600", f"{os.path.basename(path)} mode 0600")
        judge.check(entry.get("ino") == os.stat(path).st_ino,
                    f"{os.path.basename(path)} 동일 inode")
    judge.check(event.get("proc_locks", {}).get("ok") is True, "/proc/locks 읽기 성공")
    facts = isolation_facts(run) or {}
    judge.check((facts.get("hostProcLocksBinding") or {}).get("writable") is False,
                "/proc/locks RO 바인드")
    return {"status": "fail" if judge.failures else "pass",
            "evidence": "; ".join(judge.evidence), "failures": judge.failures,
            "unexecuted": ["슬롯 점유 대기: heavy_verify.py가 lock 경로 변경 옵션을 없음"],
            "details": {"proc_locks": event.get("proc_locks"), "lock": LOCK_PATHS[0]}}


def axis_observe(ctx: dict) -> dict:
    judge = Judge()
    sid = new_session_id("axis12-observe")
    processes = list_processes()
    host_sample = [pid for pid, info in sorted(processes.items())
                   if info["comm"] in {"node", "python3", "postgres", "pm2", "slackbot"}][:12]
    run = finish_job(start_job(ctx, "axis12", build_job(
        ctx, sid, "observe", {"host_pids": host_sample, "haniel_port": 9300,
                              "pm2_logs": str(MASKED["pm2_logs"]),
                              "prod_logs": str(MASKED["prod_logs"])}), 240), 240)
    event = payload_map(run).get("observe", {})
    judge.check(event.get("visible_host_pids") == [], "호스트 pid 비가시")
    judge.check(event.get("process_count", 99) < 10, "상자 안 프로세스 소수")
    judge.check((event.get("haniel_direct") or {}).get("ok") is False,
                "127.0.0.1:9300 직접 접속 거부")
    judge.check((event.get("pm2_logs") or {}).get("ok") is True, "~/.pm2/logs 읽기 성공")
    judge.check((event.get("pm2_logs_write") or {}).get("ok") is False,
                "~/.pm2/logs 쓰기 거부")
    judge.check(set(event.get("pm2_parent") or []) <= {"logs"},
                "~/.pm2는 logs만 남기고 가림")
    logs = event.get("prod_log_names") or []
    judge.check(bool(logs) and not str(logs[0]).startswith("errno:"),
                "운영 로그 디렉터리 읽기 성공")
    return {"status": "fail" if judge.failures else "pass",
            "evidence": "; ".join(judge.evidence), "failures": judge.failures,
            "details": {"observe": event, "host_sample": host_sample}}


def axis_local_mask(ctx: dict) -> dict:
    judge = Judge()
    sid = new_session_id("axis13-local")
    ws = ctx["fixture"]["ws"]
    scratch = ws / "existing-scratch"
    scratch.mkdir()
    ctx = {**ctx, "base_env": {**ctx["base_env"], "SCRATCH_WORKSPACE_DIR": str(scratch)}}
    listing_before = dir_listing(ws, 64)
    probe = finish_job(start_job(ctx, "axis13-probe", build_job(
        ctx, sid, "probe", probe_args(ctx)), 240), 240)
    checks = payload_map(probe).get("probe", {}).get("checks", {})
    judge.check(checks.get("scratch_matches_expected") is True,
                "SCRATCH_WORKSPACE_DIR 그대로")
    sandbox_dir = str((isolation_facts(probe) or {}).get("sandboxDirectory", ""))
    ops = [
        {"id": "read_sibling_runner", "mode": "read",
         "path": str(ctx["fixture"]["sibling_session"] / "runner.json")},
        {"id": "read_host_environ", "mode": "read", "path": f"/proc/{os.getpid()}/environ"},
        {"id": "list_runner_state", "mode": "list",
         "path": str(ctx["fixture"]["runner_state"])},
        {"id": "write_sandbox", "mode": "write", "path": f"{sandbox_dir}/harness-write.txt"},
    ]
    ops = available_mask_ops(judge, ops)
    run = finish_job(start_job(ctx, "axis13", build_job(ctx, sid, "files", {"ops": ops}), 240), 240)
    results = payload_map(run).get("files", {}).get("results", {})
    tested = {op["id"] for op in ops}
    if "read_sibling_runner" in tested:
        judge.check((results.get("read_sibling_runner") or {}).get("ok") is False,
                    "이웃 runner 설정 읽기 실패")
    if "read_host_environ" in tested:
        judge.check((results.get("read_host_environ") or {}).get("ok") is False,
                    "호스트 /proc/<pid>/environ 읽기 실패")
    if "list_runner_state" in tested:
        judge.check((results.get("list_runner_state") or {}).get("count") == 1,
                    "runner state 루트에는 현재 세션 sandbox만 보임")
    if "write_sandbox" in tested:
        judge.check((results.get("write_sandbox") or {}).get("ok") is True, "mask 아래 sandbox RW")
    added = [name for name in dir_listing(ws, 64) if name not in listing_before]
    judge.check(added == [], f"새 scratch 없음(추가 {added})")
    return {"status": "fail" if judge.failures else "partial" if judge.unexecuted else "pass",
            "evidence": "; ".join(judge.evidence), "failures": judge.failures,
            "unexecuted": judge.unexecuted,
            "details": {"checks": checks, "files": results, "added": added}}


def axis_claude_auth(ctx: dict) -> dict:
    judge = Judge()
    run_missing = finish_job(start_job(ctx, "axis14-missing", build_job(
        ctx, new_session_id("axis14-missing"), "true", {}, backend="claude",
        prepareOnly="assembly"), 240), 240)
    missing = (run_missing.events("assembly_failed") or [{}])[-1]
    missing_text = f"{missing.get('name', '')} {missing.get('message', '')}".lower()
    judge.check("auth" in missing_text, "token 파일 없음 → 준비 거부(fail-closed)")
    token_file = ctx["run_root"] / "synthetic-claude-token"
    token = "harness-synthetic-token-not-a-secret"
    token_file.write_text(token + "\n", encoding="utf-8")
    token_file.chmod(0o600)
    run_ok = finish_job(start_job(ctx, "axis14-ok", build_job(
        ctx, new_session_id("axis14-ok"), "claude-auth",
        {"expected_token": token, "token_file": str(token_file)}, backend="claude",
        claudePair={"tokenFile": str(token_file), "accountId": "harness-account"}), 240), 240)
    ok = (run_ok.events("prepared") or [{}])[-1]
    auth_kind = (ok.get("isolation") or {}).get("authKind")
    judge.check(ok.get("event") == "prepared", "합성 token으로 준비 성공")
    judge.check(auth_kind == "claude-oauth-token", "authKind claude-oauth-token")
    payload = payload_map(run_ok).get("claude_auth", {})
    judge.check(payload.get("token_present") is True, "상자 env에 token 키 존재")
    judge.check(payload.get("token_matches") is True, "상자 token이 합성 값과 일치")
    judge.check(payload.get("token_file_readable") is False, "상자에서 token 파일 읽기 실패")
    return {"status": "fail" if judge.failures else "pass",
            "evidence": "; ".join(judge.evidence), "failures": judge.failures,
            "details": {"missing": missing, "ok_authKind": auth_kind, "payload": payload}}


def axis_timing(ctx: dict) -> dict:
    judge = Judge()
    repos = sorted(path.name for path in REAL_PROJECTS.iterdir() if (path / ".git").is_dir())
    subs = ("objects", "refs", "logs", "worktrees")
    before = {name: {sub: (REAL_PROJECTS / name / ".git" / sub).is_dir() for sub in subs}
              for name in repos}
    job = build_job(ctx, new_session_id("axis15-timing"), "true", {})
    job.update({
        "projectsRoot": str(REAL_PROJECTS),
        "registries": [{"repoId": name, "path": str(REAL_PROJECTS / name)} for name in repos],
        "worktrees": [],
        "prepareOnly": "prepare",
        "prepareRuns": 5,
    })
    job.pop("taskWorktreeId", None)
    run = finish_job(start_job(ctx, "axis15", job, 600), 600)
    event = (run.events("prepare_only") or [{}])[-1]
    durations = event.get("runs") or []
    judge.check(len(durations) == 5, "prepare 5회 측정")
    started = time.perf_counter()
    for name in repos:
        git_run(REAL_PROJECTS / name, ["rev-parse", "--git-common-dir"], timeout=60)
    common_pass_ms = round((time.perf_counter() - started) * 1000, 1)
    created = {name: [sub for sub in subs
                      if not before[name][sub] and (REAL_PROJECTS / name / ".git" / sub).is_dir()]
               for name in repos}
    created = {name: found for name, found in created.items() if found}
    ordered = sorted(durations)
    median = ordered[len(ordered) // 2] if ordered else None
    facts = event.get("isolation") or {}
    return {"status": "fail" if judge.failures else "pass",
            "evidence": "; ".join(judge.evidence), "failures": judge.failures,
            "timing": {"runs_ms": durations, "median_ms": median,
                       "max_ms": max(durations) if durations else None,
                       "common_dir_pass_ms": common_pass_ms,
                       "common_dir_share": (round(common_pass_ms / median, 3)
                                            if median else None),
                       "repos": len(repos)},
            "details": {"created_git_subdirs": created,
                        "helper": (facts.get("tools") or {}).get("netnsHelper")}}


__all__ = ["axis_gh", "axis_termination", "axis_heavy_work", "axis_observe",
           "axis_local_mask", "axis_claude_auth", "axis_timing"]
