#!/usr/bin/env python3
"""session-netns-helper.py의 단위 시험용 실행기.

helper는 스크립트라 import 이름이 없다. importlib로 모듈처럼 읽어 들이고,
부작용 없는 조각만 주입한 대체물로 실행한다. 실제 prctl도, 실제 신호도,
실제 프로세스도 쓰지 않는다. 결과는 stdout에 JSON 한 줄로 낸다.

사용: python3 session_isolation_helper_probe.py <helper.py> <case>
"""

from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import sys


def load_helper(path: str):
    # helper는 자기 옆의 session_netns_network.py를 import한다. importlib로
    # 파일을 직접 읽을 때는 스크립트 디렉터리가 sys.path에 자동으로 들어가지
    # 않으므로 여기서 넣는다.
    helper_dir = str(pathlib.Path(path).resolve().parent)
    if helper_dir not in sys.path:
        sys.path.insert(0, helper_dir)
    spec = importlib.util.spec_from_file_location("session_netns_helper_under_test", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"could not load helper: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StatusSink:
    """helper의 STATUS_FD를 실제 파이프로 바꿔 보고 순서를 관찰한다."""

    def __init__(self, module):
        read_fd, write_fd = os.pipe()
        self._read_fd = read_fd
        self._write_fd = write_fd
        module.STATUS_FD = write_fd

    def collect(self):
        if self._write_fd is not None:
            os.close(self._write_fd)
            self._write_fd = None
        chunks = []
        while True:
            chunk = os.read(self._read_fd, 65536)
            if not chunk:
                break
            chunks.append(chunk)
        os.close(self._read_fd)
        text = b"".join(chunks).decode("utf-8")
        return [json.loads(line) for line in text.splitlines() if line.strip()]


class FakeChild:
    """bwrap 자식 대역. 실제 프로세스를 만들지 않는다."""

    def __init__(self, exit_code: int):
        self.exit_code = exit_code
        self.waited = False

    def wait(self, timeout=None):
        self.waited = True
        return self.exit_code


def open_empty_pipe():
    read_fd, write_fd = os.pipe()
    os.close(write_fd)
    return read_fd


def close_quietly(*fds):
    for fd in fds:
        try:
            os.close(fd)
        except OSError:
            pass


def run_case(module, case: str, result: dict) -> None:
    if case == "parent-death-armed":
        calls = []

        def prctl(option, sig):
            calls.append([option, sig])
            return 0

        module.set_parent_death_signal(prctl, 4321, lambda: 4321)
        result["outcome"] = "completed"
        result["calls"] = calls
        return

    if case == "parent-death-prctl-fails":
        module.set_parent_death_signal(lambda option, sig: -1, 4321, lambda: 4321)
        result["outcome"] = "completed"
        return

    if case == "parent-death-parent-changed":
        module.set_parent_death_signal(lambda option, sig: 0, 4321, lambda: 9999)
        result["outcome"] = "completed"
        return

    if case == "insert-status-fd":
        result["argv"] = module.insert_json_status_fd(
            ["/usr/bin/setpriv", "/usr/bin/bwrap", "--unshare-pid"],
            "/usr/bin/bwrap",
            9,
        )
        result["outcome"] = "completed"
        return

    if case == "insert-status-fd-missing-bwrap":
        module.insert_json_status_fd(["/usr/bin/setpriv", "/usr/bin/other"], "/usr/bin/bwrap", 9)
        result["outcome"] = "completed"
        return

    if case == "sandbox-order":
        events = []
        status_fd = open_empty_pipe()
        readiness_fd = open_empty_pipe()
        result["status_fd_open_at_wait"] = False
        result["readiness_fd_closed_after"] = False

        def start(argv, cwd, env, bwrap_path):
            events.append("start")
            result["start_argv"] = argv
            result["start_bwrap_path"] = bwrap_path
            return FakeChild(0), status_fd, readiness_fd

        def await_started(child, fd, timeout_ms):
            events.append("await-child")

        def await_exec(child, fd, timeout_ms):
            events.append("await-exec")

        def wait(child):
            events.append("wait")
            # bwrap은 CLI가 끝난 뒤에도 상태 fd에 `{"exit-code": N}`을 쓴다.
            # helper가 그 전에 읽기 끝을 닫으면 bwrap이 SIGPIPE로 죽고
            # 종료 코드가 243으로 뒤집힌다. wait 시점에 fd가 열려 있어야 한다.
            try:
                os.fstat(status_fd)
                result["status_fd_open_at_wait"] = True
            except OSError:
                result["status_fd_open_at_wait"] = False
            return 7

        module.start_launch = start
        module.await_sandbox_started = await_started
        module.await_sandbox_exec = await_exec
        module.wait_for_launch = wait
        try:
            result["code"] = module.run_sandbox({
                "argv": ["/usr/bin/bwrap"],
                "cwd": "/tmp",
                "env": {"A": "1"},
                "bwrapPath": "/usr/bin/bwrap",
                "networkTimeoutMs": 1234,
            })
        finally:
            try:
                os.fstat(readiness_fd)
            except OSError:
                result["readiness_fd_closed_after"] = True
            close_quietly(status_fd, readiness_fd)
        result["events"] = events
        result["outcome"] = "completed"
        return

    if case == "sandbox-handshake-fails":
        events = []
        result["events"] = events
        status_fd = open_empty_pipe()
        readiness_fd = open_empty_pipe()

        def start(argv, cwd, env, bwrap_path):
            events.append("start")
            return FakeChild(1), status_fd, readiness_fd

        def await_started(child, fd, timeout_ms):
            module.fail("bwrap exited with 1 before starting the sandbox command")

        def wait(child):
            events.append("wait")
            return 0

        module.start_launch = start
        module.await_sandbox_started = await_started
        module.wait_for_launch = wait
        module.run_sandbox({
            "argv": ["/usr/bin/bwrap"],
            "cwd": "/tmp",
            "env": {},
            "bwrapPath": "/usr/bin/bwrap",
            "networkTimeoutMs": 1234,
        })
        result["outcome"] = "completed"
        return

    if case == "sandbox-exec-eof":
        events = []
        result["events"] = events
        status_fd = open_empty_pipe()
        readiness_fd = open_empty_pipe()

        def start(argv, cwd, env, bwrap_path):
            events.append("start")
            return FakeChild(1), status_fd, readiness_fd

        def await_started(child, fd, timeout_ms):
            events.append("await-child")

        module.start_launch = start
        module.await_sandbox_started = await_started
        module.run_sandbox({
            "argv": ["/usr/bin/bwrap"],
            "cwd": "/tmp",
            "env": {},
            "bwrapPath": "/usr/bin/bwrap",
            "networkTimeoutMs": 1234,
        })
        result["outcome"] = "completed"
        return

    if case == "sandbox-exec-byte":
        events = []
        result["events"] = events
        status_fd = open_empty_pipe()
        readiness_read, readiness_write = os.pipe()
        os.write(readiness_write, b"x")
        os.close(readiness_write)

        def start(argv, cwd, env, bwrap_path):
            events.append("start")
            return FakeChild(0), status_fd, readiness_read

        def await_started(child, fd, timeout_ms):
            events.append("await-child")

        def wait(child):
            events.append("wait")
            return 7

        module.start_launch = start
        module.await_sandbox_started = await_started
        module.wait_for_launch = wait
        result["code"] = module.run_sandbox({
            "argv": ["/usr/bin/bwrap"],
            "cwd": "/tmp",
            "env": {},
            "bwrapPath": "/usr/bin/bwrap",
            "networkTimeoutMs": 1234,
        })
        result["outcome"] = "completed"
        return

    if case == "sandbox-exec-timeout":
        events = []
        result["events"] = events
        status_fd = open_empty_pipe()
        readiness_read, readiness_write = os.pipe()

        def start(argv, cwd, env, bwrap_path):
            events.append("start")
            return FakeChild(0), status_fd, readiness_read

        def await_started(child, fd, timeout_ms):
            events.append("await-child")

        module.start_launch = start
        module.await_sandbox_started = await_started
        try:
            module.run_sandbox({
                "argv": ["/usr/bin/bwrap"],
                "cwd": "/tmp",
                "env": {},
                "bwrapPath": "/usr/bin/bwrap",
                "networkTimeoutMs": 50,
            })
        finally:
            close_quietly(readiness_write)
        result["outcome"] = "completed"
        return

    if case == "exec-shim-insert":
        result["argv"] = module.insert_sandbox_exec_shim(
            [
                "/usr/bin/setpriv",
                "/usr/bin/bwrap",
                "--chdir",
                "/w",
                "--",
                "/usr/bin/python3",
                "/w/payload.py",
            ],
            "/usr/bin/bwrap",
        )
        result["outcome"] = "completed"
        return

    if case == "exec-shim-missing-separator":
        module.insert_sandbox_exec_shim(
            ["/usr/bin/setpriv", "/usr/bin/bwrap", "--chdir", "/w"],
            "/usr/bin/bwrap",
        )
        result["outcome"] = "completed"
        return

    if case == "await-sandbox-eof":
        status_fd = open_empty_pipe()
        try:
            module.await_sandbox_started(FakeChild(9), status_fd, 500)
        finally:
            os.close(status_fd)
        result["outcome"] = "completed"
        return

    if case == "await-sandbox-report":
        read_fd, write_fd = os.pipe()
        os.write(write_fd, b'{"child-pid": 321}\n')
        os.close(write_fd)
        child = FakeChild(9)
        try:
            module.await_sandbox_started(child, read_fd, 500)
        finally:
            os.close(read_fd)
        result["outcome"] = "completed"
        result["waited"] = child.waited
        return

    raise SystemExit(f"unknown case: {case}")


def main(argv) -> int:
    if len(argv) != 3:
        raise SystemExit("usage: session_isolation_helper_probe.py <helper.py> <case>")
    module = load_helper(argv[1])
    sink = StatusSink(module)
    result = {"case": argv[2]}
    try:
        run_case(module, argv[2], result)
    except module.HelperFailure as exc:
        result["outcome"] = "failed"
        result["message"] = str(exc)
    result["status"] = sink.collect()
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
