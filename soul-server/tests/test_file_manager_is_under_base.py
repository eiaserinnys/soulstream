"""FileManager.is_under_base() 단위 테스트.

Phase 2 (atom 260513.02 — chat-inline-attachment): 다운로드 라우트의
directory traversal 가드. private `_base_dir` 직접 접근을 막아 호출자의
지식 경계를 좁힌다(design-principles §1·§10).
"""

import os
from pathlib import Path

import pytest

from soul_server.service.file_manager import FileManager


@pytest.fixture
def base(tmp_path):
    """base_dir로 사용할 임시 디렉토리에 FileManager 인스턴스 생성."""
    return FileManager(base_dir=str(tmp_path))


def test_returns_true_for_file_directly_under_base(base, tmp_path):
    f = tmp_path / "photo.png"
    f.write_bytes(b"x")
    assert base.is_under_base(f) is True


def test_returns_true_for_nested_path_under_base(base, tmp_path):
    nested = tmp_path / "session-1" / "001_photo.png"
    nested.parent.mkdir()
    nested.write_bytes(b"x")
    assert base.is_under_base(nested) is True


def test_returns_false_for_path_outside_base(base, tmp_path):
    """traversal 시도 — base_dir 바깥 절대경로는 거부."""
    assert base.is_under_base(Path("/etc/passwd")) is False


def test_returns_false_for_parent_of_base(base, tmp_path):
    """base의 부모 디렉토리도 거부."""
    assert base.is_under_base(tmp_path.parent) is False


def test_returns_false_for_relative_parent_traversal(base, tmp_path):
    """`../` 트래버설 — resolve 후 base 바깥이면 거부."""
    traversal = tmp_path / "session-1" / ".." / ".." / "etc" / "passwd"
    assert base.is_under_base(traversal) is False


def test_returns_false_for_symlink_pointing_outside_base(base, tmp_path):
    """base 안에 base 바깥을 가리키는 symlink가 있어도 resolve된 목적지로 판정."""
    outside = tmp_path.parent / "outside-target"
    outside.write_bytes(b"secret")
    link = tmp_path / "evil-link"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("symlink not supported on this platform")
    assert base.is_under_base(link) is False


def test_returns_true_for_symlink_pointing_inside_base(base, tmp_path):
    """symlink 목적지가 base 하위면 통과."""
    inside_target = tmp_path / "target.txt"
    inside_target.write_bytes(b"ok")
    link = tmp_path / "link.txt"
    try:
        link.symlink_to(inside_target)
    except OSError:
        pytest.skip("symlink not supported on this platform")
    assert base.is_under_base(link) is True


def test_returns_false_for_broken_symlink(base, tmp_path):
    """존재하지 않는 대상을 가리키는 symlink는 보수적으로 거부 (resolve OSError 또는 ValueError)."""
    link = tmp_path / "broken-link"
    try:
        link.symlink_to(tmp_path.parent / "no-such-file")
    except OSError:
        pytest.skip("symlink not supported on this platform")
    # Path.resolve() (strict=False 기본)는 broken symlink여도 OSError를 raise하지 않으나,
    # 그 결과 경로가 base 하위가 아니므로 ValueError → False.
    assert base.is_under_base(link) is False
