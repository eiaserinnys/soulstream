#!/usr/bin/env python3
"""카드 #1111 restricted 실행 통합 하네스 (eiaserinnys).

운영 코드의 prepare·argv·policy를 그대로 쓰고, CLI 대신 payload만 바꿔
`composeSessionIsolation` → `applyRestrictedRunnerIsolation` →
`launchIsolatedSession`까지 간다. 축별 결과는 `RESULT {json}` 한 줄로 남긴다.

안전 규칙(위임문·spec 「안전 규칙」):
- 신호는 이 프로세스가 직접 띄운 자식(`OwnedChildren`)에만 보낸다.
- `signal` 축은 `--axis signal --acknowledge-signal-axis` 없이는 실행되지 않는다.
- 비밀값은 읽어도 출력하지 않는다. 사실·개수·errno만 남긴다.
- background 실행, `pgrep -f` 대기 루프, `cd`를 쓰지 않는다.
- 무거운 명령은 heavy_verify.py로만 돌린다(Playwright·pnpm install 구간).

사용: python3 verify-session-isolation.py [--axis 1,5 | --axis signal --acknowledge-signal-axis]
"""

from __future__ import annotations

import argparse
import os
import signal
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from isolation_harness_axes_probe import (  # noqa: E402
    axis_cache,
    axis_dynamic_worktree,
    axis_files,
    axis_git,
    axis_internet,
    axis_network,
    axis_network_failure,
    axis_privilege,
)
from isolation_harness_axes_runtime import (  # noqa: E402
    axis_claude_auth,
    axis_gh,
    axis_heavy_work,
    axis_local_mask,
    axis_observe,
    axis_termination,
    axis_timing,
)
from isolation_harness_axis_signal import (  # noqa: E402
    axis_signal_box,
    handshake,
    run_controller,
)
from isolation_harness_context import (  # noqa: E402
    NODE,
    PASTA,
    SERVICE_DIR,
    TSX_LOADER,
    WORKSPACE,
    DummyListener,
    HarnessSafetyError,
    OwnedChildren,
    build_fixture,
    cleanup_tree,
    curated_base_env,
    emit,
    free_port,
    host_facts,
)

AXES = {
    1: ("network", axis_network),
    2: ("privilege", axis_privilege),
    3: ("internet", axis_internet),
    4: ("network-failure", axis_network_failure),
    5: ("files", axis_files),
    6: ("dynamic-worktree", axis_dynamic_worktree),
    7: ("git", axis_git),
    8: ("cache", axis_cache),
    9: ("gh", axis_gh),
    10: ("termination", axis_termination),
    11: ("heavy-work", axis_heavy_work),
    12: ("observe", axis_observe),
    13: ("local-mask", axis_local_mask),
    14: ("claude-auth", axis_claude_auth),
    15: ("timing", axis_timing),
}

UNEXECUTED = {
    "test-db": "전용 시험 Postgres가 아직 없다(런북 단계)",
    "wsl": "WSL interop는 WSL 노드 단계",
    "internal-mcp": "직접 내부 MCP·transport·guard·관측 MCP는 enforce 서버가 필요하다",
    "unit-covered": ("full/off baseline·preset/caller·inventory·Codex auth·rolling은 "
                     "기존 단위 시험이 정본이다"),
}


def red_selftest() -> dict:
    registry = OwnedChildren()
    attempts = {
        "negative_pid": lambda: registry.register(-1),
        "zero_pid": lambda: registry.kill(0),
        "init_pid": lambda: registry.kill(1),
        "unregistered_pid": lambda: registry.kill(os.getpid()),
    }
    rejected = []
    for label, attempt in attempts.items():
        try:
            attempt()
        except HarnessSafetyError:
            rejected.append(label)
    return {"rejected": rejected, "total": len(attempts),
            "passed": len(rejected) == len(attempts)}


def build_context(run_root: Path) -> dict:
    listener = DummyListener()
    ctx: dict = {
        "run_root": run_root,
        "registry": OwnedChildren(),
        "listener": listener,
        "denied_port": free_port(),
        "internal_port": free_port(),
        "host": host_facts(),
        "base_env": curated_base_env({
            "DATABASE_URL": "harness-synthetic-database-url-not-a-secret",
            "SSH_AUTH_SOCK": "/tmp/harness-synthetic-ssh-agent",
            "SCCACHE_DIR": "/tmp/harness-synthetic-sccache",
            "AUTH_BEARER_TOKEN": "harness-synthetic-host-bearer",
        }),
        "driver_env": curated_base_env({"NODE_NO_WARNINGS": "1"}),
    }
    if os.environ.get("AGENT_COMMON_FILES_DIR"):
        ctx["driver_env"]["AGENT_COMMON_FILES_DIR"] = os.environ["AGENT_COMMON_FILES_DIR"]
    ctx["mcp_servers"] = [
        {"type": "streamable_http", "name": "harness-approved",
         "url": f"http://127.0.0.1:{listener.port}/mcp",
         "headers": {"Authorization": "Bearer harness-synthetic"}},
        {"type": "streamable_http", "name": "harness-unapproved",
         "url": f"http://127.0.0.1:{ctx['denied_port']}/mcp"},
        {"type": "streamable_http", "name": "haniel", "url": "http://127.0.0.1:9300/mcp"},
        {"type": "stdio", "name": "harness-stdio", "command": "/usr/bin/true",
         "args": [], "env": {"HARNESS_ENV": "harness"}, "headers": {"X": "y"}},
        {"type": "streamable_http", "name": "harness-external",
         "url": "https://mcp.example.com/mcp",
         "headers": {"Authorization": "Bearer harness-external"}},
    ]
    return ctx


def main() -> int:
    parser = argparse.ArgumentParser(description="카드 #1111 restricted 통합 하네스")
    parser.add_argument("--axis", default="all", help="쉼표 목록(1..15, signal) 또는 all")
    parser.add_argument("--acknowledge-signal-axis", action="store_true")
    parser.add_argument("--signal-dry-run", action="store_true",
                        help="신호 축을 kill(-1) 없이 같은 흐름으로 돌린다")
    parser.add_argument("--inside-outer-box", action="store_true",
                        help=argparse.SUPPRESS)
    parser.add_argument("--host-pidns-inode", type=int, default=None,
                        help=argparse.SUPPRESS)
    parser.add_argument("--node-id", default="eiaserinnys",
                        help="드라이버의 SOULSTREAM_NODE_ID")
    parser.add_argument("--service-dir", default=SERVICE_DIR,
                        help="드라이버 실행 cwd(운영 체크아웃)")
    parser.add_argument("--workspace", default=str(WORKSPACE),
                        help="run_root 기준 디렉터리; payload 경로를 그대로 넘기므로 상자에서 보이는 이 워크스페이스 아래 체크아웃에서 실행")
    parser.add_argument("--pasta", default=PASTA, help="pasta 실행 경로")
    parser.add_argument("--keep", action="store_true", help="시험 루트를 남긴다")
    args = parser.parse_args()

    selection = args.axis.strip()
    if selection == "all":
        names = [str(number) for number in AXES] + list(UNEXECUTED)
    else:
        names = [part.strip() for part in selection.split(",") if part.strip()]

    if "signal" in names:
        # 신호 축은 다른 축과 섞지 않는다.
        if len(names) != 1:
            emit("REFUSED", axis="signal", reason="신호 축은 다른 축과 함께 실행하지 않는다")
            return 2
        if not args.acknowledge_signal_axis:
            emit("REFUSED", axis="signal",
                 reason="안전 규칙 3: --acknowledge-signal-axis 필요")
            return 3
        if not args.inside_outer_box:
            # 호스트 controller는 신호를 보내지 않고 바깥 PID 상자만 띄운다.
            return run_controller(args)
        facts, allowed = handshake(args.host_pidns_inode, args.inside_outer_box)
        emit("SIGNAL_BOX", **facts)
        if not allowed:
            emit("REFUSED", axis="signal", reason="바깥 PID 상자 handshake 실패",
                 checks=facts["checks"])
            return 4

    known = {str(number) for number in AXES} | {"signal"}
    unknown = [name for name in names if name not in known and name not in UNEXECUTED]
    if unknown:
        emit("REFUSED", reason=f"알 수 없는 축: {unknown}")
        return 2

    run_root = Path(args.workspace) / ".local/tmp/card1111-harness" / (
        time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6])
    (run_root / "jobs").mkdir(parents=True, exist_ok=True)
    (run_root / "logs").mkdir(parents=True, exist_ok=True)

    ctx = build_context(run_root)
    ctx.update(node_id=args.node_id, service_dir=args.service_dir,
               workspace=args.workspace, pasta=args.pasta, signal_dry_run=args.signal_dry_run)
    emit("START", run_root=str(run_root), host=ctx["host"], axes=names,
         node=os.uname().nodename, uid=os.getuid(), payload=sys.executable,
         driver_cwd=args.service_dir, driver_node=NODE, tsx_loader=str(TSX_LOADER))
    emit("SELFTEST", **red_selftest())

    results: dict[str, dict] = {}
    try:
        ctx["fixture"] = build_fixture(run_root)
        for name in names:
            if name == "signal":
                started = time.monotonic()
                try:
                    outcome = axis_signal_box(ctx)
                except Exception as error:  # 하네스 자체 결함도 결과로 남긴다
                    outcome = {"status": "fail",
                               "failures": [f"{type(error).__name__}: {error}"],
                               "evidence": "하네스 예외"}
                outcome["axis"] = "signal"
                outcome["name"] = "signal"
                outcome["duration_s"] = round(time.monotonic() - started, 1)
                results[name] = outcome
                emit("RESULT", **outcome)
                continue
            if name in UNEXECUTED:
                results[name] = {"status": "not-executed", "evidence": UNEXECUTED[name],
                                 "failures": []}
                emit("RESULT", axis=name, **results[name])
                continue
            number = int(name)
            title, function = AXES[number]
            started = time.monotonic()
            try:
                outcome = function(ctx)
            except Exception as error:  # 하네스 자체 결함도 결과로 남긴다
                outcome = {"status": "fail", "failures": [f"{type(error).__name__}: {error}"],
                           "evidence": "하네스 예외"}
            outcome["axis"] = number
            outcome["name"] = title
            outcome["duration_s"] = round(time.monotonic() - started, 1)
            results[name] = outcome
            emit("RESULT", **outcome)
    finally:
        ctx["listener"].close()
        for pid in ctx["registry"].pids:
            try:
                ctx["registry"].kill(pid, signal.SIGKILL)
            except (HarnessSafetyError, ProcessLookupError):
                pass
        if not args.keep:
            fixture = ctx.get("fixture")
            if fixture:
                cleanup_tree(fixture["runner_state"])
            cleanup_tree(run_root)
    emit("SUMMARY", results={name: value["status"] for name, value in results.items()},
         run_root=str(run_root), kept=args.keep)
    return 0 if all(value["status"] in ("pass", "not-executed")
                    for value in results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
