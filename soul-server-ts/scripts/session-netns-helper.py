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
   때까지 기다렸다가 `network-ready`를 보고한다. 고정 sleep은 쓰지 않는다.
5. 준비된 argv(setpriv + bwrap + CLI)를 실행하고 그 종료 코드로 끝난다.

상태는 fd 3(JSON line), 제어 입력은 fd 4(JSON 한 줄)만 쓴다. 프로세스를
죽이는 API는 쓰지 않는다. 종료는 부모(호스트)가 보내는 시그널과 bwrap의
`--die-with-parent`가 맡는다.
"""

from __future__ import annotations

import fcntl
import json
import os
import pathlib
import socket
import struct
import subprocess
import sys
import time

STATUS_FD = 3
CONTROL_FD = 4
DEFAULT_NETWORK_TIMEOUT_MS = 30_000
POLL_INTERVAL_SECONDS = 0.05
NFT_TIMEOUT_SECONDS = 20
SIOCGIFFLAGS = 0x8913
IFF_UP = 0x1
IFF_LOOPBACK = 0x8
RTF_UP = 0x1
NETLINK_ROUTE = 0
RTM_NEWADDR = 20
RTM_GETADDR = 22
NLM_F_REQUEST = 0x1
NLM_F_DUMP = 0x300
NLMSG_ERROR = 2
NLMSG_DONE = 3
IFA_ADDRESS = 1
IFA_LOCAL = 2
NLMSG_HEADER = struct.Struct("=IHHII")
IFADDR_MESSAGE = struct.Struct("=BBBBI")
NETLINK_TIMEOUT_SECONDS = 2.0


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


def interface_flags(sock: socket.socket, name: str) -> int:
    request = struct.pack("256s", name.encode("utf-8")[:15])
    return struct.unpack("H", fcntl.ioctl(sock.fileno(), SIOCGIFFLAGS, request)[16:18])[0]


def carries_ipv4_address(attributes: bytes) -> bool:
    offset = IFADDR_MESSAGE.size
    while offset + 4 <= len(attributes):
        length, kind = struct.unpack_from("=HH", attributes, offset)
        if length < 4 or offset + length > len(attributes):
            return False
        if kind in (IFA_LOCAL, IFA_ADDRESS) and length == 8:
            if attributes[offset + 4 : offset + 8] != b"\x00\x00\x00\x00":
                return True
        offset += (length + 3) & ~3
    return False


def interfaces_with_ipv4_address() -> set[int]:
    """IPv4 주소를 가진 interface index를 netlink으로 모은다.

    `SIOCGIFADDR`은 이 커널에서 권한 없는 프로세스에 ENOTTY를 돌려준다(실측
    261109). 주소 확인은 `ip`가 쓰는 RTM_GETADDR 경로로 한다.
    """
    sock = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, socket.NETLINK_ROUTE)
    try:
        sock.settimeout(NETLINK_TIMEOUT_SECONDS)
        sequence = int(time.monotonic() * 1000) & 0xFFFFFFFF
        request = NLMSG_HEADER.pack(
            NLMSG_HEADER.size + IFADDR_MESSAGE.size,
            RTM_GETADDR,
            NLM_F_REQUEST | NLM_F_DUMP,
            sequence,
            0,
        )
        request += IFADDR_MESSAGE.pack(socket.AF_INET, 0, 0, 0, 0)
        sock.send(request)
        indexes: set[int] = set()
        while True:
            data = sock.recv(65536)
            offset = 0
            done = False
            while offset + NLMSG_HEADER.size <= len(data):
                length, kind, _, _, _ = NLMSG_HEADER.unpack_from(data, offset)
                if length < NLMSG_HEADER.size:
                    return indexes
                body = data[offset + NLMSG_HEADER.size : offset + length]
                if kind == NLMSG_DONE:
                    done = True
                elif kind == NLMSG_ERROR:
                    raise OSError("netlink refused the IPv4 address query")
                elif kind == RTM_NEWADDR and len(body) >= IFADDR_MESSAGE.size:
                    family, _, _, _, index = IFADDR_MESSAGE.unpack_from(body, 0)
                    if family == socket.AF_INET and carries_ipv4_address(body):
                        indexes.add(index)
                offset += (length + 3) & ~3
            if done:
                return indexes
    finally:
        sock.close()


def has_default_route() -> bool:
    try:
        text = pathlib.Path("/proc/net/route").read_text(encoding="ascii", errors="replace")
    except OSError:
        return False
    for line in text.splitlines()[1:]:
        fields = line.split()
        if len(fields) < 4:
            continue
        if fields[1] != "00000000":
            continue
        try:
            flags = int(fields[3], 16)
        except ValueError:
            continue
        if flags & RTF_UP:
            return True
    return False


def network_ready() -> bool:
    addressed = interfaces_with_ipv4_address()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    has_address = False
    try:
        for index, name in socket.if_nameindex():
            if index not in addressed:
                continue
            flags = interface_flags(sock, name)
            if flags & IFF_LOOPBACK or not flags & IFF_UP:
                continue
            has_address = True
    finally:
        sock.close()
    return has_address and has_default_route()


def await_network(timeout_ms: float) -> None:
    deadline = time.monotonic() + timeout_ms / 1000.0
    while time.monotonic() < deadline:
        try:
            if network_ready():
                return
        except OSError:
            pass
        time.sleep(POLL_INTERVAL_SECONDS)
    fail(f"network interface and default route did not become ready within {timeout_ms:g}ms")


def run_launch(argv: list[str], cwd: str, env: dict[str, str]) -> int:
    try:
        child = subprocess.Popen(argv, cwd=cwd, env=env, close_fds=True)
    except OSError as exc:
        fail(f"could not start the sandbox command: {exc}")
    try:
        return child.wait()
    except KeyboardInterrupt:
        return 130


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
        payload = load_payload(control_fd)
        if control_fd not in (0, 1, 2):
            try:
                os.close(control_fd)
            except OSError:
                pass
        assert_separate_network_namespace(int(payload["hostNetnsInode"]))
        install_firewall(str(payload["nftPath"]), str(payload["nftRuleset"]))
        emit("firewall-ready")
        await_network(float(payload["networkTimeoutMs"]))
        emit("network-ready")
        return run_launch(
            list(payload["argv"]),  # type: ignore[arg-type]
            str(payload["cwd"]),
            dict(payload["env"]),  # type: ignore[arg-type]
        )
    except HelperFailure as exc:
        # 상태 채널로 이미 보고했다. CLI가 남았다면 여기서 정리되지 않지만,
        # 아직 실행 전이므로 남은 프로세스는 없다.
        print(f"session netns helper failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
