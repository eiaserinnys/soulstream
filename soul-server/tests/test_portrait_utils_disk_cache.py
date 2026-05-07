"""
test_portrait_utils_disk_cache — portrait_utils의 메모리·디스크 2단 캐시 검증.

검증 케이스:
1. 디스크 hit/miss 흐름 (메모리 비어있는 상태에서 디스크 → 메모리 적재)
2. 원본 mtime 변경 시 invalidation
3. SOULSTREAM_PORTRAIT_CACHE_DIR 환경변수 우선
4. 캐시 디렉토리 자동 생성
5. cache_key 분리 — 같은 path를 다른 prefix로 호출해도 충돌 없이 별도 저장
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

# 본 테스트는 portrait_utils.load_and_resize_portrait이 PIL을 사용하여 64x64 PNG로
# 리사이즈하는 정상 흐름을 검증한다. PIL 미설치 환경에선 함수가 명시적으로 None 반환
# (silent corruption 회피)이므로 캐시 hit/miss 검증이 무의미 — skip.
pytest.importorskip("PIL", reason="portrait_utils requires Pillow — pip install Pillow")


@pytest.fixture(autouse=True)
def isolated_cache(monkeypatch, tmp_path: Path):
    """각 테스트마다 격리된 캐시 디렉토리 + 메모리 캐시 초기화."""
    cache_dir = tmp_path / "portraits"
    monkeypatch.setenv("SOULSTREAM_PORTRAIT_CACHE_DIR", str(cache_dir))

    from soul_server.api import portrait_utils

    portrait_utils._portrait_cache.clear()
    yield cache_dir
    portrait_utils._portrait_cache.clear()


def _write_image(path: Path, marker: bytes) -> None:
    """sample 이미지 작성 — PIL 있으면 정상 PNG, 없으면 PNG 헤더 + 더미 페이로드.

    portrait_utils.load_and_resize_portrait는 PIL 미설치 시 raw bytes를 그대로
    반환하므로(L46-48), PIL 없이도 캐시 동작 검증 가능.
    """
    try:
        from PIL import Image  # type: ignore

        # marker의 첫 바이트로 색상 살짝 변경 (재생성 검증용)
        c = marker[0] if marker else 128
        img = Image.new("RGBA", (64, 64), color=(c, 0, 0, 255))
        img.save(path, format="PNG")
    except ImportError:
        # PNG 매직넘버 + 더미 페이로드 (실제 디코딩 안 됨, 캐시 흐름만 검증)
        path.write_bytes(b"\x89PNG\r\n\x1a\n" + marker * 16)


@pytest.fixture
def sample_image(tmp_path: Path) -> Path:
    """sample 이미지 (PIL 있으면 PNG, 없으면 raw bytes — get_cached_portrait는 둘 다 동작)."""
    p = tmp_path / "src.png"
    _write_image(p, b"first-payload-")
    return p


def test_first_call_loads_from_source_and_writes_disk(isolated_cache: Path, sample_image: Path):
    """첫 호출 — 메모리·디스크 모두 비었으니 원본 로드 → 디스크에 저장."""
    from soul_server.api.portrait_utils import get_cached_portrait

    data = get_cached_portrait("test:first", str(sample_image))
    assert data is not None
    # 디스크 캐시에 파일이 생성되었어야 함
    files = list(isolated_cache.iterdir())
    assert len(files) == 1, f"디스크 캐시 파일 1개 생성 기대, 실제 {len(files)}"
    assert files[0].suffix == ".png"
    # 디스크에 저장된 바이트 == 반환된 데이터
    assert files[0].read_bytes() == data


def test_disk_hit_after_memory_clear(isolated_cache: Path, sample_image: Path):
    """첫 호출 후 메모리 초기화 → 두 번째 호출은 디스크에서 hit."""
    from soul_server.api import portrait_utils
    from soul_server.api.portrait_utils import get_cached_portrait

    first = get_cached_portrait("test:disk", str(sample_image))
    assert first is not None

    # 메모리만 초기화 (디스크는 그대로)
    portrait_utils._portrait_cache.clear()

    second = get_cached_portrait("test:disk", str(sample_image))
    assert second == first  # 동일 바이트


def test_mtime_invalidation_regenerates(isolated_cache: Path, sample_image: Path):
    """원본 mtime이 디스크 캐시보다 새것이면 invalidate → 재생성."""
    from soul_server.api import portrait_utils
    from soul_server.api.portrait_utils import get_cached_portrait

    # 첫 호출 — 디스크에 저장
    first = get_cached_portrait("test:mtime", str(sample_image))
    assert first is not None
    portrait_utils._portrait_cache.clear()

    # 1초 이상 대기 후 원본 덮어쓰기 (mtime 증가 보장)
    time.sleep(1.1)
    _write_image(sample_image, b"second-payload")

    # 두 번째 호출 — mtime 변화 감지하여 재생성
    second = get_cached_portrait("test:mtime", str(sample_image))
    assert second is not None
    assert second != first, "원본 변경 후 캐시가 invalidate되어야 함 (다른 바이트)"


def test_env_var_overrides_default(monkeypatch, tmp_path: Path, sample_image: Path):
    """SOULSTREAM_PORTRAIT_CACHE_DIR이 settings 기반 기본값을 override."""
    custom_dir = tmp_path / "custom-cache"
    monkeypatch.setenv("SOULSTREAM_PORTRAIT_CACHE_DIR", str(custom_dir))

    from soul_server.api import portrait_utils
    from soul_server.api.portrait_utils import get_cached_portrait

    portrait_utils._portrait_cache.clear()
    data = get_cached_portrait("test:env", str(sample_image))
    assert data is not None
    assert custom_dir.exists(), "환경변수로 지정한 디렉토리 자동 생성 기대"
    files = list(custom_dir.iterdir())
    assert len(files) == 1


def test_cache_dir_auto_creation(monkeypatch, tmp_path: Path, sample_image: Path):
    """캐시 디렉토리가 없어도 mkdir(parents=True) 자동 생성."""
    nested = tmp_path / "deep" / "nested" / "portraits"
    monkeypatch.setenv("SOULSTREAM_PORTRAIT_CACHE_DIR", str(nested))

    from soul_server.api import portrait_utils
    from soul_server.api.portrait_utils import get_cached_portrait

    portrait_utils._portrait_cache.clear()
    assert not nested.exists()
    data = get_cached_portrait("test:auto", str(sample_image))
    assert data is not None
    assert nested.is_dir()


def test_cache_key_prefix_isolation(isolated_cache: Path, sample_image: Path):
    """같은 path를 다른 cache_key로 호출하면 별도 디스크 파일에 저장."""
    from soul_server.api import portrait_utils
    from soul_server.api.portrait_utils import get_cached_portrait

    portrait_utils._portrait_cache.clear()
    a = get_cached_portrait("agent:x", str(sample_image))
    b = get_cached_portrait("user:y", str(sample_image))
    assert a == b  # 데이터는 동일
    files = list(isolated_cache.iterdir())
    assert len(files) == 2, "다른 cache_key는 다른 디스크 파일에 저장"


def test_missing_source_returns_none(isolated_cache: Path):
    """원본 파일 없으면 None 반환, 디스크에도 저장 안 함."""
    from soul_server.api.portrait_utils import get_cached_portrait

    data = get_cached_portrait("test:missing", "/nonexistent/path.png")
    assert data is None
    files = list(isolated_cache.iterdir()) if isolated_cache.exists() else []
    assert len(files) == 0
