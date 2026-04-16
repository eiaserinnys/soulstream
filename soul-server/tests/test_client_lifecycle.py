"""client_lifecycle.py 모듈 테스트"""

from types import SimpleNamespace

from soul_server.claude.client_lifecycle import compute_options_fingerprint


def test_compute_options_fingerprint_deterministic():
    """동일한 옵션이면 동일한 fingerprint를 반환한다."""
    opts1 = SimpleNamespace(
        setting_sources=["project"],
        allowed_tools=["Read", "Write"],
        disallowed_tools=["WebFetch"],
    )
    opts2 = SimpleNamespace(
        setting_sources=["project"],
        allowed_tools=["Read", "Write"],
        disallowed_tools=["WebFetch"],
    )
    assert compute_options_fingerprint(opts1) == compute_options_fingerprint(opts2)


def test_compute_options_fingerprint_different_tools():
    """allowed_tools가 다르면 fingerprint가 달라진다."""
    opts1 = SimpleNamespace(
        setting_sources=["project"],
        allowed_tools=["Read"],
        disallowed_tools=None,
    )
    opts2 = SimpleNamespace(
        setting_sources=["project"],
        allowed_tools=["Read", "Write"],
        disallowed_tools=None,
    )
    assert compute_options_fingerprint(opts1) != compute_options_fingerprint(opts2)


def test_compute_options_fingerprint_none_options():
    """options=None이면 None을 반환한다."""
    assert compute_options_fingerprint(None) is None


def test_compute_options_fingerprint_order_independent():
    """allowed_tools 순서가 달라도 동일 fingerprint를 반환한다 (sorted)."""
    opts1 = SimpleNamespace(
        setting_sources=["project"],
        allowed_tools=["Write", "Read"],
        disallowed_tools=None,
    )
    opts2 = SimpleNamespace(
        setting_sources=["project"],
        allowed_tools=["Read", "Write"],
        disallowed_tools=None,
    )
    assert compute_options_fingerprint(opts1) == compute_options_fingerprint(opts2)
