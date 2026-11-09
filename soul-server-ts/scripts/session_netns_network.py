"""session-netns-helper.py의 network 준비 확인.

helper가 pasta를 붙인 뒤 이 netns에 interface 주소와 default route가 실제로
생겼는지 확인하는 부분만 따로 둔다. 실패를 예외로 올리지 않고 bool로
돌려주므로 helper가 자기 상태 채널로 보고 형식을 정한다.

호스트의 주소 탐색과 달리 여기서는 sandbox 쪽 주소만 본다. `SIOCGIFADDR`은
이 커널에서 권한 없는 프로세스에 ENOTTY를 돌려주므로(실측 261109) `ip`가
쓰는 netlink RTM_GETADDR 경로를 쓴다.
"""

from __future__ import annotations

import fcntl
import pathlib
import socket
import struct
import time

POLL_INTERVAL_SECONDS = 0.05
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
    """IPv4 주소를 가진 interface index를 netlink으로 모은다."""
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


def await_network(timeout_ms: float) -> bool:
    """interface 주소와 default route가 준비될 때까지 기다린다. 고정 sleep은 없다."""
    deadline = time.monotonic() + timeout_ms / 1000.0
    while time.monotonic() < deadline:
        try:
            if network_ready():
                return True
        except OSError:
            pass
        time.sleep(POLL_INTERVAL_SECONDS)
    return False
