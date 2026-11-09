#!/usr/bin/env python3
"""카드 #1111 신호 축: host → 바깥 bwrap PID 상자 → 운영 격리 → payload.

호스트 controller는 kill(-1)·killpg를 부르지 않는다. 실제 신호는 바깥 PID
상자 안 payload가 자기 pid namespace 안에서만 부른다(spec-v4 §14). 바깥 상자
안에서는 handshake(pid ns inode·pid 크기·플래그)를 통과해야 안쪽 격리를
띄우고, 하나라도 어긋나면 내부 격리 없이 REFUSED로 끝난다.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys

from isolation_harness_context import (
    CLI_PATH,
    Judge,
    build_job,
    emit,
    failure_event,
    finish_job,
    payload_map,
    start_job,
    start_sentinel,
    sentinel_alive,
)
from isolation_harness_fixture import descendants, list_processes, new_session_id

BWRAP = "/usr/bin/bwrap"


def pidns_inode(path: str = "/proc/self/ns/pid") -> int | None:
    try:
        return os.stat(path).st_ino
    except OSError:
        return None


def controller_command(args) -> tuple[int, list[str]]:
    """호스트 pid ns inode와 바깥 상자 재실행 argv. 신호는 여기서 보내지 않는다."""
    host_inode = os.stat("/proc/self/ns/pid").st_ino
    command = [
        BWRAP, "--dev-bind", "/", "/", "--proc", "/proc", "--unshare-pid",
        "--die-with-parent", "--new-session", "--",
        sys.executable, str(CLI_PATH),
        "--axis", "signal", "--acknowledge-signal-axis",
        "--inside-outer-box", "--host-pidns-inode", str(host_inode),
        "--node-id", args.node_id,
        "--service-dir", args.service_dir,
        "--workspace", args.workspace,
        "--pasta", args.pasta,
    ]
    if args.signal_dry_run:
        command.append("--signal-dry-run")
    if args.keep:
        command.append("--keep")
    return host_inode, command


def run_controller(args) -> int:
    """바깥 상자를 띄우고 종료 코드·출력을 그대로 넘긴다."""
    host_inode, command = controller_command(args)
    emit("SIGNAL_CONTROLLER", host_pidns_inode=host_inode, command=command)
    try:
        completed = subprocess.run(command)
    except OSError as error:
        emit("REFUSED", axis="signal",
             reason=f"바깥 상자 실행 실패: {type(error).__name__}: {error}")
        return 6
    emit("SIGNAL_CONTROLLER_EXIT", returncode=completed.returncode)
    return completed.returncode


def handshake(host_inode: object, inside: bool) -> tuple[dict, bool]:
    """바깥 상자 안 시작 확인. 셋 중 하나라도 아니면 안쪽 격리를 띄우지 않는다."""
    own_inode = pidns_inode()
    own_pid = os.getpid()
    checks = {
        "inside_outer_box": inside is True,
        "host_pidns_inode_is_int": (
            isinstance(host_inode, int) and not isinstance(host_inode, bool)
        ),
        "pidns_differs_from_host": (
            isinstance(host_inode, int) and not isinstance(host_inode, bool)
            and isinstance(own_inode, int) and own_inode != host_inode
        ),
        "pid_is_small": own_pid < 100,
    }
    facts = {"pid": own_pid, "pidns_inode": own_inode,
             "host_pidns_inode": host_inode, "checks": checks}
    return facts, all(checks.values())


def axis_signal_box(ctx: dict) -> dict:
    """바깥 상자 안에서 운영 격리를 띄우고 payload case "signal"을 판정한다."""
    judge = Judge()
    dry_run = bool(ctx.get("signal_dry_run"))
    box_pid = os.getpid()
    box_inode = pidns_inode()
    sentinel = start_sentinel(ctx)
    sentinel_start = list_processes()[sentinel]["starttime"]
    evidence: dict = {"boxPid": box_pid, "boxPidnsInode": box_inode,
                      "dryRun": dry_run, "sentinel": sentinel}
    try:
        payload_args = {
            "acknowledge": True,
            "dry_run": dry_run,
            # payload가 비교할 controller(바깥 상자)의 pid ns inode.
            "host_pidns_inode": box_inode,
        }
        sid = new_session_id("axis-signal")
        run = start_job(ctx, "axis-signal", build_job(
            ctx, sid, "signal", payload_args), 240)
        ready = run.wait_for("ready", 180)
        processes = list_processes()
        recorded = descendants(run.pid)
        helper_pid = (ready or {}).get("helperPid")
        # pasta 실행 파일의 comm은 빌드에 따라 "pasta.avx2" 같은 접미사가 붙는다.
        pasta_pids = [item["pid"] for item in recorded
                      if str(item["comm"]).startswith("pasta")]
        evidence.update({
            "helperPid": helper_pid,
            "pastaPids": pasta_pids,
            "readyComms": {str(item["pid"]): item["comm"] for item in recorded},
        })
        finish_job(run, 240)
        events = payload_map(run)
        pre = events.get("signal_precheck", {})
        checks = pre.get("checks", {})
        exit_event = (run.events("exit") or [{}])[-1]
        evidence.update({
            "payloadPid": pre.get("own_pid"),
            "payloadPidnsInode": pre.get("own_pidns_inode"),
            "prechecks": checks,
            "payloadEvents": sorted(events),
            "sleeperExit": events.get("signal_sleeper_exit"),
            "driverExit": exit_event.get("code"),
            "events": [event.get("event") for event in run.events()],
        })
        judge.check(ready is not None, "안쪽 격리 ready")
        judge.check(isinstance(helper_pid, int) and not isinstance(helper_pid, bool)
                    and helper_pid > 1, "netns helper 기동")
        judge.check(bool(pasta_pids), "pasta 기동(바깥 상자 안)")
        judge.check(checks.get("pidns_differs_from_host") is True,
                    f"payload pid ns inode {pre.get('own_pidns_inode')}가 "
                    f"바깥 상자 {box_inode}와 다름")
        judge.check(checks.get("pid_is_small") is True,
                    f"payload pid {pre.get('own_pid')} < 100")
        judge.check(exit_event.get("code") == 0, "드라이버 정상 종료")
        if dry_run:
            judge.check("signal_would_send" in events, "dry-run would_send 기록")
            judge.check("signal_sent" not in events, "dry-run에서 실제 신호 없음")
            judge.note(f"sleeper 종료 {events.get('signal_sleeper_exit')}")
        else:
            judge.check("signal_sent" in events, "kill(-1) 전송")
            judge.check(events.get("signal_sleeper_exit", {}).get("returncode") == -15,
                        "상자 안 sleeper SIGTERM 종료")
        judge.check(sentinel_alive(sentinel, sentinel_start),
                    "바깥 sentinel 생존(동일 starttime)")
        failure = failure_event(run)
        if failure is not None:
            evidence["failure"] = failure
    finally:
        try:
            ctx["registry"].kill(sentinel, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return {"status": "fail" if judge.failures else "pass",
            "evidence": "; ".join(judge.evidence),
            "failures": judge.failures,
            "details": evidence}


__all__ = ["run_controller", "handshake", "axis_signal_box", "controller_command"]
