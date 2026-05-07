"""
Portrait 유틸리티 — 초상화 이미지 로드, 리사이즈, 메모리·디스크 캐시.

dashboard.py / agents.py / upstream/adapter.py에서 공용으로 사용한다.

캐시 계층:
  1. 메모리 (`_portrait_cache`) — 프로세스 내 최단 거리
  2. 디스크 (`_get_cache_dir()`) — 프로세스 재시작 후 재사용 (mtime 기반 invalidation)
  3. PIL 리사이즈 — 원본 파일 → 64x64 PNG (~5KB)

원본 파일이 변경되면(mtime 증가) 디스크 캐시는 자동 무효화된다.
메모리 캐시는 프로세스 단위라 변경 즉시 반영되지 않으므로, 호출자가
필요하면 `_portrait_cache.clear()`로 정리한다 (테스트가 그렇게 한다).
"""

from __future__ import annotations

import hashlib
import io
import logging
import os
from pathlib import Path
from typing import Optional

PORTRAIT_SIZE = 64  # px (retina 대응, 클라이언트에서 32x32로 표시)

logger = logging.getLogger(__name__)

# 리사이즈된 이미지 메모리 캐시 (key: 호출자가 정한 cache_key)
_portrait_cache: dict[str, bytes | None] = {}


def _get_cache_dir() -> Path:
    """portrait 디스크 캐시 디렉토리.

    우선순위:
      1. 환경변수 SOULSTREAM_PORTRAIT_CACHE_DIR
      2. settings.workspace_dir / .cache / portraits
      3. WORKSPACE_DIR / .cache / portraits (settings 미초기화 fallback)

    디렉토리는 호출 시점에 자동 생성. 실패 시 RuntimeError로 전파하지 않고
    호출자가 디스크 캐시 단계를 건너뛸 수 있도록 OSError를 그대로 던진다.
    """
    env = os.environ.get("SOULSTREAM_PORTRAIT_CACHE_DIR", "").strip()
    if env:
        cache_dir = Path(env)
    else:
        # lazy import to avoid load-time circular dependency
        try:
            from soul_server.config import get_settings  # type: ignore
            workspace = get_settings().workspace_dir
        except Exception:
            workspace = os.environ.get("WORKSPACE_DIR", "")
        if not workspace:
            raise OSError("workspace_dir 미설정으로 portrait 디스크 캐시 비활성")
        cache_dir = Path(workspace) / ".cache" / "portraits"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def _disk_cache_path(cache_key: str) -> Path:
    """캐시 키 → 디스크 파일 경로. sha1으로 키 충돌·경로 인젝션 방지."""
    h = hashlib.sha1(cache_key.encode("utf-8")).hexdigest()
    return _get_cache_dir() / f"{h}.png"


def _resolve_source_path(path_str: str) -> Path:
    """원본 path_str을 절대 경로로 변환 (load_and_resize_portrait와 동일 규칙)."""
    p = Path(path_str)
    if not p.is_absolute():
        p = Path.cwd() / p
    return p


def load_and_resize_portrait(path_str: str) -> Optional[bytes]:
    """초상화 이미지를 로드하고 PORTRAIT_SIZE x PORTRAIT_SIZE로 리사이즈.

    Args:
        path_str: 이미지 파일 경로. 상대경로면 CWD 기준.

    Returns:
        PNG 바이너리 또는 None (경로 미지정·파일 없음·로드 실패).
    """
    if not path_str:
        return None

    path = _resolve_source_path(path_str)
    if not path.exists():
        return None

    try:
        from PIL import Image

        with Image.open(path) as img:
            img = img.convert("RGBA")
            img.thumbnail((PORTRAIT_SIZE, PORTRAIT_SIZE), Image.Resampling.LANCZOS)

            buf = io.BytesIO()
            img.save(buf, format="PNG", optimize=True)
            return buf.getvalue()
    except ImportError:
        # Pillow 미설치 — silent corruption 회피: raw bytes 반환은 함수 의도(64x64 리사이즈)와
        # 정반대이고 _MAX_PORTRAIT_SIZE 가드(adapter)·Content-Type=image/png(dashboard)와도
        # 충돌한다. 운영자가 즉시 인지할 수 있도록 명시적 실패 + 에러 로그.
        # 운영 조치: `services/soulstream/venv/bin/pip install Pillow>=10.0.0`.
        logger.error(
            "Pillow 미설치로 portrait 리사이즈 불가 — pip install Pillow 필요 (path=%s)",
            path,
        )
        return None
    except Exception:
        return None


def get_cached_portrait(cache_key: str, path_str: str) -> Optional[bytes]:
    """포트레이트 PNG를 메모리·디스크 캐시 통과하여 반환.

    Args:
        cache_key: 호출자가 정한 안정 키 (예: "user:/abs/path", "agent:seosoyoung",
            "upstream:agent:seosoyoung"). path_str과 1:1 대응이어야 한다.
        path_str: 이미지 파일 경로. 상대경로면 CWD 기준.

    Returns:
        PNG 바이너리(64x64) 또는 None.

    캐시 흐름:
        1. 메모리 hit → 즉시 반환 (None도 캐시됨, 미존재 파일 재시도 방지)
        2. 디스크 hit + 원본 mtime ≤ 캐시 mtime → 메모리 적재 후 반환
        3. miss → load_and_resize_portrait → 디스크 저장(best-effort) + 메모리 적재
    """
    # 1. 메모리 캐시
    if cache_key in _portrait_cache:
        return _portrait_cache[cache_key]

    # 2. 디스크 캐시 (mtime 기반 invalidation)
    if path_str:
        try:
            src_path = _resolve_source_path(path_str)
            disk_path = _disk_cache_path(cache_key)
            if disk_path.exists() and src_path.exists():
                if disk_path.stat().st_mtime >= src_path.stat().st_mtime:
                    data = disk_path.read_bytes()
                    _portrait_cache[cache_key] = data
                    return data
        except OSError as e:
            # 디스크 캐시 비활성·접근 실패 — 다음 단계로 fallthrough (최초 1회만 로깅)
            logger.debug("portrait 디스크 캐시 건너뜀: %s", e)

    # 3. 원본 로드 + 리사이즈
    data = load_and_resize_portrait(path_str)
    _portrait_cache[cache_key] = data

    # 4. 디스크 저장 (best-effort, 실패해도 데이터 자체는 반환)
    if data:
        try:
            disk_path = _disk_cache_path(cache_key)
            disk_path.write_bytes(data)
        except OSError:
            pass  # 디스크 캐시 비활성화된 경우 등 — 메모리만으로도 작동

    return data
