"""신호 대상인 하네스 직계 자식의 생명주기 관리."""

import os
import signal
import subprocess


class HarnessError(RuntimeError):
    pass


class HarnessSafetyError(HarnessError):
    pass


class OwnedChildren:
    def __init__(self, *, kill=None, killpg=None) -> None:
        self._children: dict[int, subprocess.Popen] = {}
        self._kill = kill or os.kill
        self._killpg = killpg or os.killpg

    def register(self, child: subprocess.Popen) -> int:
        pid = getattr(child, "pid", None)
        if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 1:
            raise HarnessSafetyError("refusing to register a non-harness pid")
        self._children[pid] = child
        return pid

    def assert_owned(self, pid: object) -> int:
        if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 1:
            raise HarnessSafetyError(f"refusing to signal a non-positive pid: {pid!r}")
        if pid not in self._children:
            raise HarnessSafetyError(f"refusing to signal a pid this harness did not start: {pid}")
        return pid

    def forget(self, pid: int) -> None:
        self._children.pop(pid, None)

    def _live(self, pid: object) -> int | None:
        target = self.assert_owned(pid)
        if self._children[target].poll() is not None:
            self.forget(target)
            return None
        return target

    def kill(self, pid: object, sig: int = signal.SIGKILL) -> None:
        target = self._live(pid)
        if target is not None:
            self._kill(target, sig)

    def kill_group(self, pid: object, sig: int = signal.SIGKILL) -> None:
        target = self._live(pid)
        if target is None:
            return
        try:
            group = os.getpgid(target)
        except ProcessLookupError:
            return
        if group != target:
            raise HarnessSafetyError(f"refusing killpg: pid {target} is not a session leader")
        self._killpg(target, sig)

    @property
    def pids(self) -> set[int]:
        return set(self._children)
