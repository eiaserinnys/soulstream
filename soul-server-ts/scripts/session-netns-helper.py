#!/usr/bin/env python3
"""restricted 세션의 net namespace 안에서 nft를 걸고 실행을 이어받는 helper.

호스트는 이 파일을 다음 argv로 띄운다.

    unshare --user --map-current-user --keep-caps --net <이 파일> \\
        --status-fd 3 --control-fd 4

이 프로세스는 이미 새 user/net namespace 안에서 시작한다. 순서는 다음과 같다.

1. 제어 fd에서 한 줄짜리 JSON 설정을 읽는다.
2. 호스트 network namespace에 있지 않은지 확인한다. 확인되지 않으면 nft를
   실행하지 않고 실패한다.
3. 설정에 담긴 nft 규칙을 이 netns 안에서 적용하고 `firewall-ready`를 보고한다.
4. 호스트가 pasta를 붙인다. interface 주소와 default route가 실제로 준비될
   때까지 기다린다. 고정 sleep은 쓰지 않는다.
5. 준비된 argv(setpriv + bwrap + CLI)를 실행한다. bwrap이 `--json-status-fd`로
   샌드박스 자식 pid를 알리고, sandbox 안 shim이 mount를 마치고 명령을
   exec하기 직전에 ready 바이트를 쓴 뒤에야 `network-ready`를 보고한다.
   bwrap 0.12.0의 child-pid는 mount 전에 나오므로 그 하나로는 ready를
   내지 않는다. setpriv나 bwrap이 그 전에 실패하면 ready를 거부하고 끝난다.
6. CLI의 종료 코드로 끝난다.

상태는 fd 3(JSON line), 제어 입력은 fd 4(JSON 한 줄)만 쓴다. 프로세스를
죽이는 API는 쓰지 않는다. 부모가 죽으면 이 프로세스는 prctl(PR_SET_PDEATHSIG,
SIGKILL)로, 그 아래는 bwrap의 `--die-with-parent`와 `--unshare-pid`로 정리되고,
pasta는 netns가 사라지면 스스로 끝난다.
"""

from __future__ import annotations

import ctypes
import json
import os
import select
import signal
import subprocess
import sys
import time
from typing import Callable

from session_netns_network import await_network

STATUS_FD = 3
CONTROL_FD = 4
DEFAULT_NETWORK_TIMEOUT_MS = 30_000
NFT_TIMEOUT_SECONDS = 20
PR_SET_PDEATHSIG = 1
BWRAP_JSON_STATUS_FD_FLAG = "--json-status-fd"
SANDBOX_CHILD_PID_KEY = "child-pid"
# sandbox 안 shim이 exec 직전에 한 바이트를 쓰는 fd. helper가 이 바이트를
# 받은 뒤에만 network-ready를 낸다.
READINESS_FD = 9
SANDBOX_SHIM_PATH = "/bin/sh"
SANDBOX_READY_SCRIPT = 'printf x >&9; exec 9>&-; exec "$@"'


class HelperFailure(RuntimeError):
    """helper가 스스로 멈춰야 하는 상태."""


def emit(status: str, message: str | None = None) -> None:
    payload: dict[str, object] = {"status": status}
    if message is not None:
        payload["message"] = message
    try:
        os.write(STATUS_FD, (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
    except OSError:
        pass


def fail(message: str):
    emit("error", message)
    raise HelperFailure(message)


def set_parent_death_signal(
    prctl_call: Callable[[int, int], int],
    expected_parent_pid: int,
    current_parent_pid: Callable[[], int] = os.getppid,
) -> None:
    """부모가 죽을 때 SIGKILL을 받도록 무장한다.

    prctl이 실패하면 helper는 시작을 거부한다. 무장 직후 부모 pid가 시작할
    때와 달라졌다면 부모가 이미 죽은 것이므로(그러면 death signal은 오지
    않는다) 그 자리에서 끝낸다. prctl 호출은 시험에서 갈아 끼울 수 있게
    인자로 받는다.
    """
    result = prctl_call(PR_SET_PDEATHSIG, int(signal.SIGKILL))
    if result != 0:
        errno_value = ctypes.get_errno()
        detail = os.strerror(errno_value) if errno_value else "unknown error"
        fail(f"prctl(PR_SET_PDEATHSIG) failed: {detail}")
    if current_parent_pid() != expected_parent_pid:
        fail("parent process died before the parent-death signal was armed")


def arm_parent_death_signal() -> None:
    """libc prctl로 부모 사망 신호를 건다. 실패하면 시작하지 않는다."""
    try:
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        prctl = libc.prctl
    except OSError as exc:
        fail(f"could not load libc prctl: {exc}")
    expected_parent_pid = os.getppid()
    set_parent_death_signal(
        lambda option, sig: int(prctl(option, sig, 0, 0, 0)),
        expected_parent_pid,
    )


def read_control_line(fd: int) -> str:
    chunks: list[bytes] = []
    while True:
        chunk = os.read(fd, 65536)
        if not chunk:
            break
        chunks.append(chunk)
        if b"\n" in chunk:
            break
    text = b"".join(chunks).decode("utf-8", errors="replace")
    line = text.split("\n", 1)[0].strip()
    if not line:
        fail("control channel closed before the launch payload arrived")
    return line


def load_payload(fd: int) -> dict[str, object]:
    line = read_control_line(fd)
    try:
        payload = json.loads(line)
    except json.JSONDecodeError as exc:
        fail(f"control payload is not valid JSON: {exc}")
    if not isinstance(payload, dict):
        fail("control payload is not a JSON object")
    if payload.get("version") != 1:
        fail(f"unsupported control payload version: {payload.get('version')!r}")
    nft_path = payload.get("nftPath")
    ruleset = payload.get("nftRuleset")
    host_netns_inode = payload.get("hostNetnsInode")
    launch = payload.get("launch")
    if not isinstance(host_netns_inode, int) or isinstance(host_netns_inode, bool) or host_netns_inode <= 0:
        fail("control payload has no host netns inode")
    if not isinstance(nft_path, str) or not nft_path:
        fail("control payload has no nft path")
    if not isinstance(ruleset, str) or not ruleset.strip():
        fail("control payload has no nft ruleset")
    if not isinstance(launch, dict):
        fail("control payload has no launch section")
    argv = launch.get("argv")
    cwd = launch.get("cwd")
    env = launch.get("env")
    if not isinstance(argv, list) or not argv or not all(isinstance(item, str) for item in argv):
        fail("launch argv is not a non-empty string list")
    if not isinstance(cwd, str) or not cwd:
        fail("launch cwd is missing")
    if not isinstance(env, dict) or not all(
        isinstance(key, str) and isinstance(value, str) for key, value in env.items()
    ):
        fail("launch env is not a string map")
    bwrap_path = payload.get("bwrapPath")
    if not isinstance(bwrap_path, str) or not bwrap_path:
        fail("control payload has no bwrap path")
    timeout = payload.get("networkTimeoutMs", DEFAULT_NETWORK_TIMEOUT_MS)
    if not isinstance(timeout, (int, float)) or timeout <= 0:
        fail("network timeout is not a positive number")
    return {
        "nftPath": nft_path,
        "nftRuleset": ruleset,
        "hostNetnsInode": host_netns_inode,
        "argv": argv,
        "cwd": cwd,
        "env": env,
        "bwrapPath": bwrap_path,
        "networkTimeoutMs": float(timeout),
    }


def namespace_inode(path: str) -> int:
    return os.stat(path).st_ino


def assert_separate_network_namespace(host_inode: int) -> None:
    """이 프로세스가 호스트 network namespace에 있으면 nft를 실행하지 않는다.

    child user namespace의 프로세스는 부모 쪽 `/proc/<pid>/ns/net`을 읽을 수
    없다. 그래서 호스트가 시작 전에 기록한 자기 netns inode와 이 프로세스의
    inode만 비교한다.
    """
    try:
        own = namespace_inode("/proc/self/ns/net")
    except OSError as exc:
        fail(f"cannot verify the network namespace: {exc}")
    if own == host_inode:
        fail("refusing to run nft: still inside the host network namespace")


def minimal_env() -> dict[str, str]:
    return {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}


def install_firewall(nft_path: str, ruleset: str) -> None:
    try:
        result = subprocess.run(
            [nft_path, "-f", "-"],
            input=ruleset.encode("utf-8"),
            capture_output=True,
            timeout=NFT_TIMEOUT_SECONDS,
            env=minimal_env(),
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        fail(f"nft could not be executed: {exc}")
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace").strip()
        fail(f"nft failed with exit {result.returncode}: {stderr[-800:]}")


def insert_json_status_fd(argv: list[str], bwrap_path: str, fd: int) -> list[str]:
    """bwrap argv에 `--json-status-fd <fd>`를 실행 파일 바로 뒤에 넣는다."""
    if not bwrap_path or argv.count(bwrap_path) != 1:
        fail("launch argv does not reference the bwrap executable exactly once")
    index = argv.index(bwrap_path)
    return [*argv[: index + 1], BWRAP_JSON_STATUS_FD_FLAG, str(fd), *argv[index + 1 :]]


def insert_sandbox_exec_shim(argv: list[str], bwrap_path: str) -> list[str]:
    """bwrap이 exec할 명령 앞에 ready 바이트 shim을 끼운다.

    bwrap 0.12.0의 `--json-status-fd` `child-pid`는 namespace clone 직후,
    즉 mount(`setup_newroot`) 전에 나온다(소스 확인·실측 261109). 그래서
    child-pid만으로는 mount 실패를 걸러 내지 못한다. shim은 mount가 모두
    끝나고 명령을 exec하기 직전에 파이프에 한 바이트를 쓰므로, 이 바이트가
    mount 성공의 증거다. shim은 곧바로 `exec`으로 원래 명령이 되므로
    프로세스 계층과 argv는 그대로다.
    """
    if not bwrap_path or argv.count(bwrap_path) != 1:
        fail("launch argv does not reference the bwrap executable exactly once")
    index = argv.index(bwrap_path)
    separator = argv.index("--", index) if "--" in argv[index:] else -1
    if separator == -1:
        fail("launch argv has no command separator after the bwrap executable")
    return [
        *argv[: separator + 1],
        SANDBOX_SHIM_PATH,
        "-c",
        SANDBOX_READY_SCRIPT,
        SANDBOX_SHIM_PATH,
        *argv[separator + 1 :],
    ]


def close_quietly(*fds: int) -> None:
    for fd in fds:
        try:
            os.close(fd)
        except OSError:
            pass


def start_launch(
    argv: list[str],
    cwd: str,
    env: dict[str, str],
    bwrap_path: str,
) -> tuple[subprocess.Popen, int, int]:
    """bwrap을 띄우고 (자식, 상태 fd, ready fd)를 돌려준다.

    상태 fd에는 bwrap이 JSON 상태를 쓴다. ready fd에는 sandbox 안 shim이
    mount를 마치고 명령을 exec하기 직전에 한 바이트를 쓴다. bwrap의
    `child-pid`는 mount 전에 나오므로 ready 판정에는 shim 바이트를 쓴다.
    두 fd의 쓰기 끝은 부모(helper)에서 닫아야 shim과 bwrap이 죽을 때
    EOF를 볼 수 있다.
    """
    status_read, status_write = os.pipe()
    readiness_read, ready_source = os.pipe()
    readiness_write = ready_source
    if readiness_write != READINESS_FD:
        if READINESS_FD in (status_read, status_write, readiness_read):
            close_quietly(status_read, status_write, readiness_read, readiness_write)
            fail("readiness fd collides with the helper's own descriptors")
        os.dup2(readiness_write, READINESS_FD)
        os.close(readiness_write)
        readiness_write = READINESS_FD
    try:
        launch_argv = insert_sandbox_exec_shim(
            insert_json_status_fd(argv, bwrap_path, status_write),
            bwrap_path,
        )
        child = subprocess.Popen(
            launch_argv,
            cwd=cwd,
            env=env,
            close_fds=True,
            pass_fds=(status_write, readiness_write),
        )
    except OSError as exc:
        close_quietly(status_read, status_write, readiness_read, readiness_write)
        fail(f"could not start the sandbox command: {exc}")
    except HelperFailure:
        close_quietly(status_read, status_write, readiness_read, readiness_write)
        raise
    close_quietly(status_write, readiness_write)
    return child, status_read, readiness_read


def await_sandbox_started(
    child: subprocess.Popen,
    status_fd: int,
    timeout_ms: float,
) -> None:
    """bwrap이 자식 pid를 보고할 때까지 기다린다. 그 전에 끝나면 실패한다.

    child-pid는 mount 성공의 증거가 아니다(bwrap이 clone 직후 보고). 그
    판정은 await_sandbox_exec의 shim 바이트가 맡는다.
    """
    deadline = time.monotonic() + timeout_ms / 1000.0
    buffer = b""
    while True:
        while b"\n" in buffer:
            line, _, buffer = buffer.partition(b"\n")
            text = line.decode("utf-8", errors="replace").strip()
            if not text:
                continue
            try:
                message = json.loads(text)
            except json.JSONDecodeError:
                continue
            if isinstance(message, dict) and isinstance(message.get(SANDBOX_CHILD_PID_KEY), int):
                return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            fail(f"bwrap did not report the sandbox child within {timeout_ms:g}ms")
        ready, _, _ = select.select([status_fd], [], [], remaining)
        if not ready:
            fail(f"bwrap did not report the sandbox child within {timeout_ms:g}ms")
        chunk = os.read(status_fd, 4096)
        if not chunk:
            try:
                code = child.wait(timeout=max(0.0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                code = None
            fail(f"bwrap exited with {code} before starting the sandbox command")
        buffer += chunk


def await_sandbox_exec(child: subprocess.Popen, readiness_fd: int, timeout_ms: float) -> None:
    """sandbox 안 명령이 exec 직전에 쓰는 ready 바이트를 기다린다.

    bwrap의 `child-pid`는 mount 전에 오므로 mount 성공의 증거가 아니다.
    shim 바이트는 `setup_newroot`가 끝나고 `execve` 직전에 쓰인다. EOF가
    먼저 오면 bwrap이 mount 단계에서 실패한 것이므로 종료 코드를 실어
    실패한다.
    """
    deadline = time.monotonic() + timeout_ms / 1000.0
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            fail(f"the sandbox command did not start within {timeout_ms:g}ms")
        ready, _, _ = select.select([readiness_fd], [], [], remaining)
        if not ready:
            fail(f"the sandbox command did not start within {timeout_ms:g}ms")
        chunk = os.read(readiness_fd, 1)
        if chunk:
            return
        try:
            code = child.wait(timeout=max(0.0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            code = None
        fail(f"bwrap exited with {code} before starting the sandbox command")


def wait_for_launch(child: subprocess.Popen) -> int:
    try:
        return child.wait()
    except KeyboardInterrupt:
        return 130


def run_sandbox(payload: dict[str, object]) -> int:
    """network 준비 뒤의 실행 구간.

    두 증거가 모두 도착한 뒤에만 `network-ready`를 낸다.

    1. bwrap의 `child-pid` — bwrap이 샌드박스 프로세스를 만들었다.
    2. sandbox 안 shim의 ready 바이트 — mount가 끝나고 명령을 exec한다.

    bwrap 0.12.0은 `child-pid`를 mount 전에 보고하므로(소스·실측 261109)
    1번만으로는 mount 실패가 ready로 샌다. setpriv나 bwrap이 그 전에
    실패하면 HelperFailure가 올라가고 ready는 나가지 않는다.

    상태 fd의 읽기 끝은 자식이 끝날 때까지 닫지 않는다. bwrap은 CLI가
    끝난 뒤에도 이 fd에 `{"exit-code": N}`을 쓴다. 그 전에 닫으면 bwrap의
    write가 SIGPIPE로 죽어 정상 종료한 세션이 -13(종료 코드 243)으로
    보고된다(261109 실측).
    """
    timeout_ms = float(payload["networkTimeoutMs"])  # type: ignore[arg-type]
    child, status_fd, readiness_fd = start_launch(
        list(payload["argv"]),  # type: ignore[arg-type]
        str(payload["cwd"]),
        dict(payload["env"]),  # type: ignore[arg-type]
        str(payload["bwrapPath"]),
    )
    try:
        await_sandbox_started(child, status_fd, timeout_ms)
        await_sandbox_exec(child, readiness_fd, timeout_ms)
        emit("network-ready")
        return wait_for_launch(child)
    finally:
        close_quietly(readiness_fd, status_fd)


def main(argv: list[str]) -> int:
    global STATUS_FD, CONTROL_FD
    status_fd = STATUS_FD
    control_fd = CONTROL_FD
    index = 1
    while index < len(argv):
        argument = argv[index]
        if argument == "--status-fd" and index + 1 < len(argv):
            status_fd = int(argv[index + 1])
            index += 2
            continue
        if argument == "--control-fd" and index + 1 < len(argv):
            control_fd = int(argv[index + 1])
            index += 2
            continue
        print(f"unknown argument: {argument}", file=sys.stderr)
        return 2
    try:
        os.fstat(status_fd)
        os.fstat(control_fd)
    except OSError as exc:
        print(f"status/control fd is not open: {exc}", file=sys.stderr)
        return 2
    STATUS_FD = status_fd
    CONTROL_FD = control_fd

    try:
        # 부모가 죽으면 이 helper도 함께 사라져야 한다. 그 아래(bwrap, CLI)는
        # --die-with-parent와 --unshare-pid가, pasta는 netns 소멸이 정리한다.
        arm_parent_death_signal()
        payload = load_payload(control_fd)
        if control_fd not in (0, 1, 2):
            try:
                os.close(control_fd)
            except OSError:
                pass
        assert_separate_network_namespace(int(payload["hostNetnsInode"]))
        install_firewall(str(payload["nftPath"]), str(payload["nftRuleset"]))
        emit("firewall-ready")
        timeout_ms = float(payload["networkTimeoutMs"])  # type: ignore[arg-type]
        if not await_network(timeout_ms):
            fail(f"network interface and default route did not become ready within {timeout_ms:g}ms")
        return run_sandbox(payload)
    except HelperFailure as exc:
        # 상태 채널로 이미 보고했다. CLI가 남았다면 여기서 정리되지 않지만,
        # 아직 실행 전이므로 남은 프로세스는 없다.
        print(f"session netns helper failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
