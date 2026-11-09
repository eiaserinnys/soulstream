#!/usr/bin/env python3
"""카드 #1111 하네스 축 9~15: gh·종료 회수·heavy lock·관측·로컬 mask·인증·준비 시간."""

from __future__ import annotations

import json
import os
import signal
import time
from pathlib import Path

from isolation_harness_context import (
    HOME,
    LOCK_PATHS,
    MASKED,
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


def write_claude_accounts(root: Path) -> dict:
    """합성 계정 풀. A=유효, B=만료, C=자격 없음. 실제 계정은 건드리지 않는다."""
    nonce = f"{os.getpid()}-{int(time.time() * 1000)}"
    tokens = {
        "account-a": f"harness-synthetic-token-a-{nonce}",
        "account-b": f"harness-synthetic-token-b-{nonce}",
    }
    profiles = root / "profiles"
    for name in ("account-a", "account-b", "account-c"):
        profile = profiles / name
        profile.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(profile, 0o700)
    now_ms = int(time.time() * 1000)
    for name, expires_at in (("account-a", now_ms + 3_600_000),
                             ("account-b", now_ms - 3_600_000)):
        path = profiles / name / ".credentials.json"
        path.write_text(json.dumps({
            "claudeAiOauth": {
                "accessToken": tokens[name],
                "refreshToken": f"harness-synthetic-refresh-{name}",
                "expiresAt": expires_at,
            },
        }), encoding="utf-8")
        path.chmod(0o600)
    accounts = [{
        "id": name,
        "email": f"{name}@harness.invalid",
        "plan": "max",
        "enabled": True,
        "priority": None,
        "created_at": "2026-01-01T00:00:00.000Z",
    } for name in ("account-a", "account-b", "account-c")]
    (root / "accounts.json").write_text(
        json.dumps({"version": 1, "accounts": accounts}), encoding="utf-8")
    (root / "bindings.json").write_text(
        json.dumps({"version": 1, "bindings": {}}), encoding="utf-8")
    (root / "blocks.json").write_text(
        json.dumps({"version": 1, "blocks": {}}), encoding="utf-8")
    return {"root": root, "tokens": tokens}


def axis_claude_auth(ctx: dict) -> dict:
    judge = Judge()
    # 1. 계정 풀이 꺼져 있으면 CLI를 띄우기 전에 닫힌다.
    run_off = finish_job(start_job(ctx, "axis14-pool-off", build_job(
        ctx, new_session_id("axis14-pool-off"), "true", {}, backend="claude",
        prepareOnly="assembly"), 240), 240)
    off = (run_off.events("assembly_failed") or [{}])[-1]
    judge.check(off.get("name") == "IsolationAuthUnavailableError",
                "계정 풀 없음 → IsolationAuthUnavailableError")
    judge.check("계정 풀" in str(off.get("message")),
                "계정 풀 없음 → 안내 문구")

    fixture = write_claude_accounts(ctx["run_root"] / "axis14-accounts")
    accounts_dir = str(fixture["root"])
    home_dir = str(ctx["run_root"] / "axis14-home")
    base_auth = {"accountsDir": accounts_dir, "homeDir": home_dir, "model": "opus"}

    # 2. A를 제외하면 만료된 B가 갱신되어 선택되고, 상자는 B의 접근 토큰만 받는다.
    run_ok = finish_job(start_job(ctx, "axis14-ok", build_job(
        ctx, new_session_id("axis14-ok"), "claude-auth", {}, backend="claude",
        claudeAuth={**base_auth, "excludeIds": ["account-a"]}), 240), 240)
    prepared = (run_ok.events("prepared") or [{}])[-1]
    isolation = prepared.get("isolation") or {}
    judge.check(prepared.get("event") == "prepared", "합성 계정 풀로 준비 성공")
    judge.check(isolation.get("authKind") == "claude-oauth-token",
                "authKind claude-oauth-token")
    judge.check((isolation.get("childEnv") or {}).get("claudeCodeOauthToken") is False,
                "준비 결과 env에 토큰 없음")
    selection = (run_ok.events("claude_selection") or [{}])[-1]
    judge.check(selection.get("accountId") == "account-b", "만료 계정 B가 선택")
    judge.check(selection.get("configDirInSandbox") is True,
                "선택 응답 config_dir가 sandbox 설정")
    judge.check(selection.get("profileTokenMatchesSelection") is True,
                "선택 토큰이 갱신된 자격 파일 값")
    judge.check(selection.get("envTokenMatchesSelection") is True,
                "턴 env 토큰이 선택 토큰")
    judge.check(selection.get("envCredentialKeysAbsent") is True,
                "다른 자격 env 키 제거")
    judge.check(selection.get("envConfigDirMatches") is True,
                "턴 env CLAUDE_CONFIG_DIR이 sandbox 설정")
    renew_calls = selection.get("renewCalls") or {}
    judge.check(renew_calls.get("account-b", 0) >= 1, "만료 계정 B 갱신 실행")
    judge.check("account-a" not in renew_calls, "제외 계정 A는 갱신하지 않음")
    judge.check("account-c" not in renew_calls, "자격 없는 C는 갱신하지 않음")
    payload = payload_map(run_ok).get("claude_auth", {})
    judge.check(payload.get("token_present") is True, "상자 env에 token 키 존재")
    judge.check(payload.get("token_matches") is True, "상자 토큰이 갱신된 B 토큰")
    judge.check(payload.get("config_dir_matches") is True,
                "상자 CLAUDE_CONFIG_DIR 일치")
    judge.check(payload.get("config_dir_writable") is True,
                "상자 sandbox 설정 쓰기 가능")
    judge.check(payload.get("projects_present") is True, "sandbox projects 생성")
    judge.check(payload.get("accounts_dir_entries") == [],
                "상자에서 계정 풀 루트가 비어 있음")
    judge.check(all(value is False for value in
                    (payload.get("credential_files_readable") or {}).values()),
                "상자에서 자격 파일 읽기 실패")
    judge.check(all(value is False for value in
                    (payload.get("other_credential_env_present") or {}).values()),
                "다른 자격 env 키 없음")
    judge.check((run_ok.events("exit") or [{}])[-1].get("code") == 0, "정상 종료")

    # 3. 자격 후보가 하나도 없으면 CLI payload 전에 닫힌다. C는 선택되지 않는다.
    run_empty = finish_job(start_job(ctx, "axis14-empty", build_job(
        ctx, new_session_id("axis14-empty"), "claude-auth", {}, backend="claude",
        claudeAuth={**base_auth, "excludeIds": ["account-a", "account-b"],
                    "mode": "select-only"}), 240), 240)
    empty = (run_empty.events("claude_selection_unavailable") or [{}])[-1]
    judge.check(empty.get("name") == "IsolationAuthUnavailableError",
                "자격 후보 0 → IsolationAuthUnavailableError")
    judge.check("계정 자격" in str(empty.get("message")), "자격 없음 안내 문구")
    judge.check(not run_empty.payload(), "자격 후보 0 → CLI payload 미실행")

    # 4. 갱신이 실패해 만료 상태가 남아도 fail-closed다.
    # 시나리오 2의 갱신이 B를 유효하게 만들었으므로, 만료 상태를 다시 만들려면
    # 별도 합성 계정 루트가 필요하다.
    renew_fixture = write_claude_accounts(ctx["run_root"] / "axis14-accounts-renew")
    run_renew = finish_job(start_job(ctx, "axis14-renew-fail", build_job(
        ctx, new_session_id("axis14-renew-fail"), "claude-auth", {}, backend="claude",
        claudeAuth={**base_auth, "accountsDir": str(renew_fixture["root"]),
                    "excludeIds": ["account-a"], "mode": "select-only",
                    "renewFails": True}), 240), 240)
    renew_fail = (run_renew.events("claude_selection_unavailable") or [{}])[-1]
    judge.check(renew_fail.get("name") == "IsolationAuthUnavailableError",
                "갱신 실패 → IsolationAuthUnavailableError")
    judge.check(not run_renew.payload(), "갱신 실패 → CLI payload 미실행")

    # 5. 하네스 산출물에 토큰 원문이 남지 않는다.
    tokens = [*fixture["tokens"].values(), *renew_fixture["tokens"].values()]
    leaked = [line for run in (run_ok, run_empty, run_renew, run_off)
              for line in run.lines if any(token in line for token in tokens)]
    for directory in ("jobs", "logs"):
        for path in (ctx["run_root"] / directory).glob("*"):
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if any(token in text for token in tokens):
                leaked.append(str(path))
    judge.check(not leaked, "산출물에 토큰 원문 없음")

    return {"status": "fail" if judge.failures else "pass",
            "evidence": "; ".join(judge.evidence), "failures": judge.failures,
            "details": {"pool_off": off, "selection": selection, "payload": payload,
                        "empty": empty, "renew_fail": renew_fail, "leaked": leaked}}


def axis_timing(ctx: dict) -> dict:
    judge = Judge()
    real_projects = Path(ctx["workspace"]) / ".projects"
    repos = sorted(path.name for path in real_projects.iterdir() if (path / ".git").is_dir())
    subs = ("objects", "refs", "logs", "worktrees")
    before = {name: {sub: (real_projects / name / ".git" / sub).is_dir() for sub in subs}
              for name in repos}
    job = build_job(ctx, new_session_id("axis15-timing"), "true", {})
    job.update({
        "projectsRoot": str(real_projects),
        "registries": [{"repoId": name, "path": str(real_projects / name)} for name in repos],
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
        git_run(real_projects / name, ["rev-parse", "--git-common-dir"], timeout=60)
    common_pass_ms = round((time.perf_counter() - started) * 1000, 1)
    created = {name: [sub for sub in subs
                      if not before[name][sub] and (real_projects / name / ".git" / sub).is_dir()]
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
