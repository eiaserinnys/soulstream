"""
Portrait 유틸리티 — 초상화 이미지 로드, 리사이즈, 캐시

dashboard.py와 agents.py에서 공용으로 사용한다.
"""

import io
from pathlib import Path
from typing import Optional

PORTRAIT_SIZE = 64  # px (retina 대응, 클라이언트에서 32x32로 표시)

# 리사이즈된 이미지 메모리 캐시 (key: 파일 경로 문자열)
_portrait_cache: dict[str, bytes | None] = {}


def load_and_resize_portrait(path_str: str) -> Optional[bytes]:
    """초상화 이미지를 로드하고 PORTRAIT_SIZE x PORTRAIT_SIZE로 리사이즈.

    Args:
        path_str: 이미지 파일 경로. 상대경로면 CWD 기준.

    Returns:
        PNG 바이너리 또는 None (경로 미지정, 파일 없음, 로드 실패 시).
    """
    if not path_str:
        return None

    path = Path(path_str)
    if not path.is_absolute():
        path = Path.cwd() / path

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
        # Pillow 미설치 시 원본 파일을 그대로 반환
        return path.read_bytes()
    except Exception:
        return None


def get_cached_portrait(cache_key: str, path_str: str) -> Optional[bytes]:
    """캐시된 portrait을 반환하거나, 없으면 로드하여 캐시한다.

    Args:
        cache_key: 캐시 키 (예: "user:/path/to/image.png", "agent:seosoyoung")
        path_str: 이미지 파일 경로.

    Returns:
        PNG 바이너리 또는 None.
    """
    if cache_key not in _portrait_cache:
        _portrait_cache[cache_key] = load_and_resize_portrait(path_str)
    return _portrait_cache[cache_key]
