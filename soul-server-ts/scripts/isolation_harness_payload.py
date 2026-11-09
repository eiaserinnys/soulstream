#!/usr/bin/env python3
"""카드 #1111 restricted 통합 하네스의 상자 안 payload.

이 파일은 운영 코드가 만든 restricted bwrap 상자 *안*에서만 실행된다.
비밀값(토큰, 환경변수 값, 인증 파일 내용)은 어떤 경우에도 stdout으로 내보내지
않는다. 사실과 errno만 JSON 줄로 남기고 판정은 상자 밖 controller가 한다.

`signal` case는 안전 규칙 3에 따라 코드만 두고 실행하지 않는다. controller가
`--axis signal`과 명시적 승인 플래그를 받았을 때만 도달하며, kill(-1) 직전에
pid namespace inode와 자기 pid를 확인해 하나라도 아니면 중단한다.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time

from isolation_harness_payload_box import (
    case_cache,
    case_files,
    case_gh,
    case_locks,
    case_observe,
    case_privilege,
)
from isolation_harness_payload_common import (
    commit_all,
    emit,
    err_name,
    git,
    head,
    ns_inode,
    run,
    tcp,
    write_file,
)


def case_probe(args: dict) -> None:
    scratch = os.environ.get("SCRATCH_WORKSPACE_DIR", "")
    store = os.environ.get("npm_config_store_dir", "")
    emit(
        "probe",
        pid=os.getpid(),
        ppid=os.getppid(),
        uid=os.getuid(),
        gid=os.getgid(),
        cwd=os.getcwd(),
        pidns_inode=ns_inode("/proc/self/ns/pid"),
        netns_inode=ns_inode("/proc/self/ns/net"),
        env_keys=sorted(os.environ),
        checks={
            "scratch_matches_expected": scratch == args.get("scratch_expected", ""),
            "store_dir_matches_expected": store == args.get("store_expected", ""),
            "auth_bearer_is_ssr1": os.environ.get("AUTH_BEARER_TOKEN", "").startswith("ssr1."),
            "database_url_absent": "DATABASE_URL" not in os.environ,
            "test_database_url_absent": "TEST_DATABASE_URL" not in os.environ,
            "ssh_auth_sock_absent": "SSH_AUTH_SOCK" not in os.environ,
            "pm2_home_absent": "PM2_HOME" not in os.environ,
            "sccache_absent": not [k for k in os.environ if k.startswith("SCCACHE_")],
            "git_config_count": os.environ.get("GIT_CONFIG_COUNT"),
            "gh_token_present": "GH_TOKEN" in os.environ,
            "gh_config_dir_present": "GH_CONFIG_DIR" in os.environ,
            "host_pidns_matches": ns_inode("/proc/self/ns/pid") == args.get("host_pidns_inode"),
        },
    )
    hold = float(args.get("hold_seconds", 0))
    if hold > 0:
        time.sleep(hold)


def case_network(args: dict) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    own = tcp("127.0.0.1", listener.getsockname()[1])
    listener.close()
    results = {
        "approved_dummy": tcp("127.0.0.1", int(args["approved_port"])),
        "unapproved_loopback": tcp("127.0.0.1", int(args["denied_port"])),
        "host_public_ip": tcp(args["host_ip"], 80),
        "private_192_168": tcp("192.168.0.1", 80),
        "link_local_metadata": tcp("169.254.169.254", 80),
        "docker_bridge": tcp(args["docker_bridge"], 80),
    }
    abstract = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        abstract.connect("\0" + args["abstract_name"])
        results["abstract_unix"] = {"ok": True}
    except OSError as exc:
        results["abstract_unix"] = {"ok": False, "errno": err_name(exc)}
    finally:
        abstract.close()
    emit("network", own_loopback=own, checks=results)
    hold = float(args.get("hold_seconds", 0))
    if hold > 0:
        time.sleep(hold)


def case_claude_auth(args: dict) -> None:
    token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")
    try:
        with open(args["token_file"], "rb") as handle:
            handle.read(1)
        readable = True
    except OSError:
        readable = False
    emit("claude_auth", token_present=token is not None,
         token_matches=token == args["expected_token"], token_file_readable=readable)


NODE_FETCH = (
    'fetch("https://api.github.com/").then(async (r) => {'
    'console.log(JSON.stringify({status: r.status}));'
    'process.exit(r.status === 200 ? 0 : 1);'
    '}).catch((e) => {console.error(String((e && e.name) || e)); process.exit(2);});'
)

PLAYWRIGHT = """
import json
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
    page = browser.new_page()
    page.goto("about:blank")
    page.goto("https://example.com/", timeout=45000)
    print(json.dumps({"title_present": bool(page.title()), "url_ok": page.url.startswith("https://")}))
    browser.close()
"""


def case_internet(args: dict) -> None:
    fetch = run(["node", "-e", NODE_FETCH], timeout=60)
    emit(
        "internet_node_fetch",
        rc=fetch["rc"],
        status_200='"status":200' in fetch["out"],
        err=head(fetch["err"]) if fetch["rc"] != 0 else "",
    )
    ls_remote = run(["/usr/bin/git", "ls-remote", args["repo_url"]], timeout=90)
    emit(
        "internet_git_https",
        rc=ls_remote["rc"],
        lines=len(ls_remote["out"].splitlines()),
        err=head(ls_remote["err"]) if ls_remote["rc"] != 0 else "",
    )
    npm = run(["npm", "view", "is-number", "version"], timeout=90)
    emit(
        "internet_npm_view",
        rc=npm["rc"],
        version_len=len(npm["out"].strip()),
        err=head(npm["err"]) if npm["rc"] != 0 else "",
    )
    dest = args["pip_dest"]
    os.makedirs(dest, exist_ok=True)
    pip = run(
        [sys.executable, "-m", "pip", "download", "--no-deps", "--no-cache-dir",
         "--dest", dest, "six==1.16.0"],
        timeout=120,
    )
    downloaded = sorted(os.listdir(dest)) if os.path.isdir(dest) else []
    emit(
        "internet_pip_download",
        rc=pip["rc"],
        files=len(downloaded),
        err=head(pip["err"]) if pip["rc"] != 0 else "",
    )
    playwright = run([sys.executable, "-c", PLAYWRIGHT], timeout=180)
    emitted = playwright["out"].strip().splitlines()
    emit(
        "internet_playwright",
        rc=playwright["rc"],
        result=emitted[-1] if emitted else "",
        err=head(playwright["err"]) if playwright["rc"] != 0 else "",
    )


def case_git(args: dict) -> None:
    owned = args["owned"]
    attached = args["attached"]
    update = args["session_root"]
    dynamic = os.path.join(update, "dynamic")
    branch = args["dynamic_branch"]
    created = git(owned, "worktree", "add", dynamic, "-b", branch, "HEAD")
    emit("dynamic_worktree_add", rc=created["rc"], err=head(created["err"]) if created["rc"] else "")
    dynamic_result = None
    if created["rc"] == 0:
        write_file(os.path.join(dynamic, "dynamic.txt"), "dynamic\n")
        dynamic_result = commit_all(dynamic, "harness dynamic worktree")
        dynamic_result["head"] = git(dynamic, "rev-parse", "HEAD")["out"].strip()[:12]
        dynamic_result["common_dir"] = git(dynamic, "rev-parse", "--git-common-dir")["out"].strip()
    owned_result = None
    attached_result = None
    for label, path in (("owned", owned), ("attached", attached)):
        write_file(os.path.join(path, "harness-%s.txt" % label), label + "\n")
        result = commit_all(path, "harness %s worktree" % label)
        result["head"] = git(path, "rev-parse", "HEAD")["out"].strip()[:12]
        if label == "owned":
            owned_result = result
        else:
            attached_result = result
    neighbor = args["neighbor"]
    try:
        shutil.rmtree(neighbor)
        neighbor_rm = {"ok": True}
    except OSError as exc:
        neighbor_rm = {"ok": False, "errno": err_name(exc)}
    neighbor_git = git(owned, "worktree", "remove", "--force", neighbor)
    emit(
        "dynamic_worktree",
        add=created["rc"],
        dynamic=dynamic_result,
        owned=owned_result,
        attached=attached_result,
        neighbor_rmtree=neighbor_rm,
        neighbor_git_remove={
            "rc": neighbor_git["rc"],
            "err": head(neighbor_git["err"]) if neighbor_git["rc"] != 0 else "",
        },
    )


def case_gitflow(args: dict) -> None:
    owned = args["owned"]
    bare = args["bare"]
    origin = args["remote"]
    branch = args["branch"]
    stale = args["stale_branch"]
    tracking = "refs/remotes/%s/%s" % (origin, stale)
    steps: dict[str, dict] = {}

    def step(name: str, *argv: str) -> dict:
        result = git(owned, *argv, timeout=120)
        steps[name] = {
            "rc": result["rc"],
            "err": head(result["err"]) if result["rc"] != 0 else "",
        }
        return result

    add = step("remote_add", "remote", "add", origin, bare)
    if add["rc"] != 0:
        step("remote_set_url", "remote", "set-url", origin, bare)
    step("fetch", "fetch", origin)
    steps["stale_before_prune"] = {"rc": git(owned, "rev-parse", "--verify", tracking)["rc"]}
    delete_stale = run(["/usr/bin/git", "-C", bare, "branch", "-D", stale])
    steps["remote_delete_stale"] = {"rc": delete_stale["rc"]}
    step("fetch_prune", "fetch", "--prune", origin)
    steps["stale_after_prune"] = {"rc": git(owned, "rev-parse", "--verify", tracking)["rc"]}
    step("rebase", "rebase", "%s/main" % origin)
    write_file(os.path.join(owned, "flow.txt"), "flow\n")
    commit = commit_all(owned, "harness rebase commit")
    steps["commit"] = {"rc": commit["commit_rc"], "err": commit.get("err", "")}
    step("push", "push", "-u", origin, branch)
    upstream = git(owned, "rev-parse", "--abbrev-ref", "%s@{upstream}" % branch)
    steps["upstream"] = {"rc": upstream["rc"], "value": upstream["out"].strip()}
    steps["packed_refs"] = {
        "rc": git(owned, "show-ref", "--head")["rc"],
        "has_packed": os.path.exists(os.path.join(args["common_dir"], "packed-refs")),
    }
    # 상자 안 ssh가 /etc/ssh/ssh_config.d(호스트 root 소유)를 Include로 읽을 때
    # user namespace에서 uid 65534로 보여 "Bad owner or permissions"로 죽는지 본다.
    # `-G`는 설정만 해석하고 네트워크를 쓰지 않는다.
    ssh_config = run(["/usr/bin/ssh", "-G", "github.com"], timeout=60)
    ssh_stderr = ssh_config["err"] or ""
    steps["ssh_config"] = {
        "rc": ssh_config["rc"],
        "bad_owner": "Bad owner" in ssh_stderr,
        "err": head(ssh_stderr) if ssh_config["rc"] != 0 else "",
    }
    emit("gitflow", steps=steps)


def _stop_owned_sleeper(sleeper: subprocess.Popen) -> int:
    """자기 Popen으로 띄운 sleeper만 종료한다(#1102 재발 방지)."""
    pid = sleeper.pid
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 1:
        raise RuntimeError("refusing to signal a non-owned sleeper pid")
    sleeper.terminate()
    return pid


def case_signal(args: dict) -> None:
    """안전 규칙 3·spec §14: 바깥 PID 상자 handshake 뒤에만 도달한다.

    실제 kill(-1)은 이 함수의 마지막 else 분기 하나뿐이다. dry-run은 그
    분기에 도달하지 않고, 자기 Popen으로 띄운 sleeper를 그 객체로 종료한다.
    `host_pidns_inode`는 controller(바깥 상자)의 pid ns inode다.
    """
    if not args.get("acknowledge"):
        emit("signal_axis", executed=False, reason="controller did not acknowledge")
        return
    dry_run = args.get("dry_run") is True
    sleeper = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(300)"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    emit("signal_sleeper", pid=sleeper.pid)
    host_inode = args.get("host_pidns_inode")
    own_inode = ns_inode("/proc/self/ns/pid")
    own_pid = os.getpid()
    # 두 값이 모두 int이고 서로 다를 때만 통과한다. None끼리 비교로
    # 자동 통과하던 구멍을 막는다.
    both_int = (
        isinstance(host_inode, int) and not isinstance(host_inode, bool)
        and isinstance(own_inode, int) and not isinstance(own_inode, bool)
    )
    checks = {
        "pidns_differs_from_host": both_int and own_inode != host_inode,
        "pid_is_small": own_pid < 100,
    }
    emit("signal_precheck", own_pid=own_pid, own_pidns_inode=own_inode,
         host_pidns_inode=host_inode, checks=checks)
    if not all(checks.values()):
        emit("signal_aborted", reason="precheck failed")
        _stop_owned_sleeper(sleeper)
        sleeper.wait(timeout=5)
        return
    if dry_run:
        emit("signal_would_send", signal="SIGTERM", dry_run=True)
        _stop_owned_sleeper(sleeper)
    else:
        os.kill(-1, signal.SIGTERM)
        emit("signal_sent")
    try:
        returncode = sleeper.wait(timeout=5)
    except subprocess.TimeoutExpired:
        returncode = None
    emit("signal_sleeper_exit", returncode=returncode, timed_out=returncode is None)


CASES = {
    "claude-auth": case_claude_auth,
    "probe": case_probe,
    "network": case_network,
    "internet": case_internet,
    "git": case_git,
    "gitflow": case_gitflow,
    "cache": case_cache,
    "gh": case_gh,
    "locks": case_locks,
    "observe": case_observe,
    "privilege": case_privilege,
    "files": case_files,
    "signal": case_signal,
}


def main() -> int:
    if len(sys.argv) < 2:
        emit("payload_error", reason="missing case")
        return 2
    name = sys.argv[1]
    if name == "true":
        emit("ready")
        return 0
    if name == "sleep":
        seconds = 120.0
        if len(sys.argv) > 2:
            try:
                seconds = float(json.loads(sys.argv[2]).get("seconds", 120.0))
            except (ValueError, AttributeError):
                seconds = 120.0
        emit("ready")
        time.sleep(seconds)
        return 0
    handler = CASES.get(name)
    if handler is None:
        emit("payload_error", reason="unknown case", case=name)
        return 2
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    handler(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
