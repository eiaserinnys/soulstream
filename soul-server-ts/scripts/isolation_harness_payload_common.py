#!/usr/bin/env python3
"""restricted 상자 안 payload가 공유하는 helpers. content는 내보내지 않는다."""

from __future__ import annotations

import errno
import json
import os
import socket
import subprocess
import sys

PREFIX = "PAYLOAD_JSON:"


def emit(event: str, **data: object) -> None:
    sys.stdout.write(
        PREFIX + json.dumps({"event": event, **data}, ensure_ascii=False) + "\n"
    )
    sys.stdout.flush()


def err_name(exc: BaseException) -> str:
    if isinstance(exc, OSError) and exc.errno is not None:
        return errno.errorcode.get(exc.errno, str(exc.errno))
    return type(exc).__name__


def run(command: list[str], *, cwd: str | None = None, timeout: int = 120) -> dict:
    """자식 명령 결과. stdout/stderr는 길이만 남기고 content는 돌려주지 않는다."""
    try:
        proc = subprocess.run(
            command,
            cwd=cwd,
            timeout=timeout,
            capture_output=True,
            text=True,
            env=dict(os.environ),
        )
        return {"rc": proc.returncode, "out": proc.stdout, "err": proc.stderr}
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"rc": None, "out": "", "err": str(exc), "error": True}


def head(text: str, limit: int = 300) -> str:
    line = text.strip().splitlines()[0] if text.strip() else ""
    return line[:limit]


def tcp(host: str, port: int, timeout: float = 3.0) -> dict:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect((host, port))
        return {"ok": True}
    except OSError as exc:
        return {"ok": False, "errno": err_name(exc)}
    finally:
        sock.close()


def read_status() -> dict[str, str]:
    wanted = ("CapEff", "CapPrm", "CapBnd", "NoNewPrivs", "Seccomp")
    facts: dict[str, str] = {}
    with open("/proc/self/status", encoding="ascii", errors="replace") as handle:
        for line in handle:
            key, _, value = line.partition(":")
            if key in wanted:
                facts[key] = value.strip()
    return facts


def ns_inode(path: str) -> int | None:
    try:
        return os.stat(path).st_ino
    except OSError:
        return None


def write_file(path: str, text: str) -> dict:
    try:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
        return {"ok": True}
    except OSError as exc:
        return {"ok": False, "errno": err_name(exc)}


def git(cwd: str, *argv: str, timeout: int = 90) -> dict:
    return run(["/usr/bin/git", "-C", cwd, *argv], timeout=timeout)


def commit_all(cwd: str, message: str) -> dict:
    add = git(cwd, "add", "-A")
    if add["rc"] != 0:
        return {"add_rc": add["rc"], "commit_rc": None, "err": head(add["err"])}
    result = git(
        cwd, "-c", "user.name=Isolation Harness", "-c", "user.email=harness@example.invalid",
        "commit", "-m", message,
    )
    return {
        "add_rc": add["rc"],
        "commit_rc": result["rc"],
        "err": head(result["err"]) if result["rc"] != 0 else "",
    }
