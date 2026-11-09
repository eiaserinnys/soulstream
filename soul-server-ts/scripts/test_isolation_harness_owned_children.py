from unittest.mock import Mock

from isolation_harness_fixture import OwnedChildren


def test_reaped_child_is_never_signalled():
    fake_kill = Mock()
    fake_killpg = Mock()
    child = Mock(pid=12345)
    child.poll.return_value = 0
    for method in ("kill", "kill_group"):
        registry = OwnedChildren(kill=fake_kill, killpg=fake_killpg)
        registry.register(child)
        getattr(registry, method)(child.pid)
        assert child.pid not in registry.pids

    fake_kill.assert_not_called()
    fake_killpg.assert_not_called()
