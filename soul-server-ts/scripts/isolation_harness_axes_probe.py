#!/usr/bin/env python3
"""카드 #1111 하네스 축 1~8: 상자 안 관측·권한·네트워크·실패·파일·git·캐시."""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import uuid

from pathlib import Path

from isolation_harness_context import (
    CACHE_ROOT,
    Judge,
    build_job,
    available_mask_ops,
    descendants,
    failure_event,
    finish_job,
    git_run,
    isolation_facts,
    judge_files,
    new_session_id,
    payload_map,
    probe_args,
    session_root,
    start_job,
    tree_fingerprint,
    write_ops,
)


def axis_network(ctx: dict) -> dict:
    judge = Judge()
    sid = new_session_id("axis1-network")
    denied = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    abstract = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    abstract_name = "harness-unapproved-" + uuid.uuid4().hex
    denied.bind(("127.0.0.1", ctx["denied_port"]))
    denied.listen(4)
    abstract.bind("\0" + abstract_name)
    abstract.listen(4)
    try:
        with socket.create_connection(("127.0.0.1", ctx["denied_port"]), timeout=3):
            pass
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
            probe.settimeout(3)
            probe.connect("\0" + abstract_name)
        return _axis_network_with_listeners(ctx, judge, sid, abstract_name)
    finally:
        denied.close()
        abstract.close()


def _axis_network_with_listeners(ctx: dict, judge: Judge, sid: str, abstract_name: str) -> dict:
    judge.note("미승인 TCP 및 abstract unix 리스너에 호스트 연결 성공")
    args = {"approved_port": ctx["listener"].port, "denied_port": ctx["denied_port"],
            "host_ip": ctx["host"]["host_ip"], "docker_bridge": "172.17.0.1",
            "abstract_name": abstract_name, "hold_seconds": 12}
    run = start_job(ctx, "axis1", build_job(ctx, sid, "network", args), 240)
    ready = run.wait_for("ready", 120)
    counters: dict = {"ok": False, "reason": "ready 없음"}
    if ready and isinstance(ready.get("helperPid"), int):
        helper = ready["helperPid"]
        if helper in {entry["pid"] for entry in descendants(run.pid)}:
            result = subprocess.run(
                ["/usr/bin/nsenter", "-t", str(helper), "-n", "/usr/sbin/nft", "list", "ruleset"],
                capture_output=True, text=True, timeout=20,
            )
            if result.returncode == 0:
                counters = {"ok": True,
                            "counters": [int(n) for n in re.findall(r"counter packets (\d+)",
                                                                    result.stdout)]}
            else:
                counters = {"ok": False, "rc": result.returncode,
                            "err": (result.stderr.strip().splitlines() or [""])[0][:120]}
    finish_job(run, 240)
    network = payload_map(run).get("network", {})
    checks = network.get("checks", {})
    judge.check(network.get("own_loopback", {}).get("ok") is True, "상자 자체 loopback 성공")
    judge.check(checks.get("approved_dummy", {}).get("ok") is True, "승인 포트 연결 성공")
    judge.check(ctx["listener"].accepted(0.5) >= 1, "승인 포트 host 연결 수신")
    for key in ("unapproved_loopback", "host_public_ip", "private_192_168",
                "link_local_metadata", "docker_bridge", "abstract_unix"):
        judge.check(checks.get(key, {}).get("ok") is False, f"{key} 거부")
    judge.note(f"거부 errno {json.dumps({k: v.get('errno') for k, v in checks.items()})}")
    judge.note(f"nft counter 관측 {json.dumps(counters, ensure_ascii=False)}")
    status = "fail" if judge.failures else ("pass" if counters.get("ok") else "partial")
    if not counters.get("ok"):
        judge.note("거부는 errno로만 판정했다(nft counter는 netns 재진입 권한이 없어 관측 불가)")
    return {"status": status, "evidence": "; ".join(judge.evidence),
            "failures": judge.failures, "details": {"checks": checks, "counters": counters}}


def axis_privilege(ctx: dict) -> dict:
    judge = Judge()
    sid = new_session_id("axis2-privilege")
    run = finish_job(start_job(ctx, "axis2", build_job(ctx, sid, "privilege", {}), 240), 240)
    event = payload_map(run).get("privilege", {})
    status_facts = event.get("status", {})
    judge.check(event.get("uid") == ctx["host"]["uid"], "상자 uid == 호스트 uid")
    judge.check(status_facts.get("CapEff", "1").strip("0") == "", "CapEff 0")
    judge.check(status_facts.get("CapPrm", "1").strip("0") == "", "CapPrm 0")
    judge.check(status_facts.get("CapBnd", "1").strip("0") == "", "CapBnd 0")
    judge.check(status_facts.get("NoNewPrivs") == "1", "NoNewPrivs 1")
    judge.check(event.get("nft_add", {}).get("rc") not in (0, None), "nft 규칙 변경 실패")
    judge.check(event.get("nsenter", {}).get("rc") not in (0, None), "nsenter 실패")
    judge.check(event.get("setns", {}).get("ok") is not True, "setns 실패")
    return {"status": "fail" if judge.failures else "pass",
            "evidence": "; ".join(judge.evidence), "failures": judge.failures,
            "details": {"status": status_facts, "nft": event.get("nft_add"),
                        "nsenter": event.get("nsenter"), "setns": event.get("setns")}}


def axis_internet(ctx: dict) -> dict:
    judge = Judge()
    sid = new_session_id("axis3-internet")
    args = {"repo_url": "https://github.com/eiaserinnys/soulstream",
            "pip_dest": f"{ctx['fixture']['ws']}/.local/tmp/pip-download"}
    run = finish_job(start_job(ctx, "axis3", build_job(ctx, sid, "internet", args),
                               900, heavy=True), 900)
    events = payload_map(run)
    judge.check(events.get("internet_node_fetch", {}).get("status_200") is True,
                "Node fetch 200")
    judge.check(events.get("internet_git_https", {}).get("rc") == 0, "git ls-remote https")
    judge.check(events.get("internet_npm_view", {}).get("rc") == 0, "npm view")
    judge.check(events.get("internet_pip_download", {}).get("rc") == 0
                and events.get("internet_pip_download", {}).get("files", 0) >= 1,
                "pip download")
    playwright = events.get("internet_playwright", {})
    try:
        parsed = json.loads(playwright.get("result") or "{}")
    except ValueError:
        parsed = {}
    judge.check(playwright.get("rc") == 0 and parsed.get("title_present") is True,
                "Playwright Chromium https")
    return {"status": "fail" if judge.failures else "pass",
            "evidence": "; ".join(judge.evidence), "failures": judge.failures,
            "unexecuted": ["Git SSH: 이 노드 ~/.ssh에 개인 키 없음"],
            "details": events}


def axis_network_failure(ctx: dict) -> dict:
    judge = Judge()
    cases = {
        "bad_pasta": {"pastaPath": "/nonexistent/harness-pasta"},
        "bad_helper": {"netnsHelperOverride": "/bin/false"},
        "bad_nft": {"nftOverride": "/bin/false"},
    }
    details = {}
    for label, override in cases.items():
        sid = new_session_id(f"axis4-{label}")
        job = build_job(ctx, sid, "true", {}, **override)
        run = finish_job(start_job(ctx, f"axis4-{label}", job, 240), 240)
        event = failure_event(run) or {}
        name = str(event.get("name", ""))
        message = str(event.get("message", ""))
        executed = len(run.payload())
        details[label] = {"event": event.get("event"), "name": name,
                          "message": message[:160], "payload_lines": executed,
                          "exit": run.returncode}
        judge.check("IsolationUnavailable" in name or "SESSION_ISOLATION_UNAVAILABLE" in message,
                    f"{label}: SESSION_ISOLATION_UNAVAILABLE 계열 오류")
        judge.check(executed == 0, f"{label}: payload 0회 실행")
    return {"status": "fail" if judge.failures else "pass",
            "evidence": "; ".join(judge.evidence), "failures": judge.failures,
            "details": details}


def axis_files(ctx: dict) -> dict:
    judge = Judge()
    sid = new_session_id("axis5-files")
    session_dir = session_root(ctx, sid)
    probe = finish_job(start_job(ctx, "axis5-probe", build_job(ctx, sid, "probe",
                                                               probe_args(ctx)), 240), 240)
    facts = isolation_facts(probe) or {}
    judge.check(facts.get("sessionWorktreeRoot") == session_dir,
                "sessionWorktreeRoot == 계산값")
    sandbox_dir = str(facts.get("sandboxDirectory", ""))
    ops = available_mask_ops(judge, write_ops(ctx, session_dir, sandbox_dir))
    run = finish_job(start_job(ctx, "axis5", build_job(
        ctx, sid, "files", {"ops": ops}), 300), 300)
    results = payload_map(run).get("files", {}).get("results", {})
    judge_files(judge, results, ops)
    return {"status": "fail" if judge.failures else "partial" if judge.unexecuted else "pass",
            "evidence": "; ".join(judge.evidence), "failures": judge.failures,
            "unexecuted": judge.unexecuted, "details": results}


def axis_dynamic_worktree(ctx: dict) -> dict:
    judge = Judge()
    sid = new_session_id("axis6-dynamic")
    session_dir = session_root(ctx, sid)
    args = {"owned": str(ctx["fixture"]["owned"]), "attached": str(ctx["fixture"]["attached"]),
            "session_root": session_dir, "dynamic_branch": "harness-dynamic",
            "neighbor": str(ctx["fixture"]["neighbor"])}
    run = finish_job(start_job(ctx, "axis6", build_job(ctx, sid, "git", args), 300), 300)
    event = payload_map(run).get("dynamic_worktree", {})
    judge.check(event.get("add") == 0, "동적 worktree add 성공")
    judge.check((event.get("dynamic") or {}).get("commit_rc") == 0,
                "동적 worktree commit 성공")
    judge.check((event.get("owned") or {}).get("commit_rc") == 0, "소유 worktree commit")
    judge.check((event.get("attached") or {}).get("commit_rc") == 0, "부착 worktree commit")
    judge.check((event.get("neighbor_rmtree") or {}).get("ok") is False,
                "비소유 worktree rmtree 거부")
    judge.check((event.get("neighbor_git_remove") or {}).get("rc") != 0,
                "비소유 worktree git remove 거부")
    listing = git_run(ctx["fixture"]["repo"], ["worktree", "list", "--porcelain"])
    judge.note("호스트 worktree 목록 " + str(sorted(
        line for line in (listing.stdout if listing.returncode == 0 else "").splitlines()
        if line.startswith("worktree "))))
    return {"status": "fail" if judge.failures else "pass",
            "evidence": "; ".join(judge.evidence), "failures": judge.failures,
            "details": event}


def axis_git(ctx: dict) -> dict:
    judge = Judge()
    sid = new_session_id("axis7-git")
    fixture = ctx["fixture"]
    common = fixture["common_dir"]
    before = {name: tree_fingerprint(common / name)
              for name in ("config", "packed-refs", "hooks", "info")}
    args = {"owned": str(fixture["owned"]), "bare": str(fixture["bare"]),
            "remote": "harness", "branch": "harness-owned",
            "stale_branch": "stale/one", "common_dir": str(common)}
    run = finish_job(start_job(ctx, "axis7", build_job(ctx, sid, "gitflow", args), 300), 300)
    steps = payload_map(run).get("gitflow", {}).get("steps", {})
    for name in ("remote_add", "fetch", "fetch_prune", "rebase", "commit", "push"):
        judge.check((steps.get(name) or {}).get("rc") == 0, f"{name} 성공")
    judge.check((steps.get("stale_before_prune") or {}).get("rc") == 0,
                "prune 전 stale ref 존재")
    judge.check((steps.get("stale_after_prune") or {}).get("rc") != 0,
                "prune 후 stale ref 제거")
    judge.check("harness" in (steps.get("upstream") or {}).get("value", ""), "upstream 설정")
    judge.check((steps.get("packed_refs") or {}).get("has_packed") is True,
                "packed-refs 존재 경로")
    ssh_config = steps.get("ssh_config") or {}
    judge.check(ssh_config.get("rc") == 0, "상자 안 ssh -G 성공")
    judge.check(ssh_config.get("bad_owner") is False, "ssh 설정 소유자 검사 통과")
    after = {name: tree_fingerprint(common / name) for name in before}
    for name in ("config", "packed-refs", "hooks", "info"):
        judge.check(before[name] == after[name], f"호스트 {name} 불변")
    pushed = git_run(fixture["bare"], ["rev-parse", "harness-owned"])
    judge.check(pushed.returncode == 0 and len(pushed.stdout.strip()) == 40,
                "bare remote에 push된 브랜치 존재")
    return {"status": "fail" if judge.failures else "pass",
            "evidence": "; ".join(judge.evidence), "failures": judge.failures,
            "details": {"steps": steps, "remote_head": pushed.stdout.strip()[:12]}}


def axis_cache(ctx: dict) -> dict:
    judge = Judge()
    fixture = ctx["fixture"]
    main_store = Path(ctx["host"]["main_store"]) if ctx["host"].get("main_store") else None
    store_before = tree_fingerprint(main_store, limit=50) if main_store else {}
    expected = str(CACHE_ROOT / "pnpm-store")
    a = finish_job(start_job(ctx, "axis8-a", build_job(
        ctx, new_session_id("axis8-cache-a"), "cache",
        {"project": str(fixture["cache_a"]), "pnpm_args": ["add", "is-number@7.0.0"],
         "expected_store": expected, "timeout": 420}), 900, heavy=True), 900)
    b = finish_job(start_job(ctx, "axis8-b", build_job(
        ctx, new_session_id("axis8-cache-b"), "cache",
        {"project": str(fixture["cache_b"]), "pnpm_args": ["install", "--prefer-offline"],
         "expected_store": expected, "timeout": 420}), 900, heavy=True), 900)
    events_a = payload_map(a)
    events_b = payload_map(b)
    judge.check(events_a.get("cache_install", {}).get("rc") == 0, "세션 A pnpm add 성공")
    judge.check((events_a.get("cache_install") or {}).get("store_dir_matches") is True,
                "세션 A store가 격리 store")
    judge.check(events_b.get("cache_install", {}).get("rc") == 0, "세션 B pnpm install 성공")
    judge.check(events_b.get("cache_import", {}).get("rc") == 0, "세션 B 기본 import 성공")
    for label, events in (("A", events_a), ("B", events_b)):
        judge.check((events.get("playwright_cache_write") or {}).get("ok") is False,
                    f"세션 {label} Playwright cache 쓰기 거부")
    store_after = tree_fingerprint(main_store, limit=50) if main_store else {}
    judge.check(store_before == store_after, "호스트 pnpm 주 store 불변")
    return {"status": "fail" if judge.failures else "pass",
            "evidence": "; ".join(judge.evidence), "failures": judge.failures,
            "details": {"a": events_a, "b": events_b, "main_store": str(main_store),
                        "store_before": store_before, "store_after": store_after}}
