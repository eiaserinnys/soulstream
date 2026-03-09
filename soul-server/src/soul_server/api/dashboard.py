"""
Dashboard profile API - 대시보드 프로필 설정 및 초상화 서빙

대시보드 채팅창에서 사용자/어시스턴트의 이름과 프로필 이미지를 표시하기 위한 API.
초상화 이미지는 soul-server가 파일시스템에서 읽어 리사이즈 후 HTTP로 서빙한다.
(대시보드 서버가 파일을 직접 읽지 않도록 하기 위함)
"""

import io
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse, Response

from ..config import get_settings

router = APIRouter(prefix="/dashboard", tags=["dashboard"])

# 리사이즈된 이미지 메모리 캐시
_portrait_cache: dict[str, bytes | None] = {}

PORTRAIT_SIZE = 64  # px (retina 대응, 클라이언트에서 32x32로 표시)


def _load_and_resize_portrait(path_str: str) -> bytes | None:
    """초상화 이미지를 로드하고 PORTRAIT_SIZE x PORTRAIT_SIZE로 리사이즈"""
    if not path_str:
        return None

    path = Path(path_str)
    if not path.is_absolute():
        # 상대경로면 CWD 기준
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


@router.get("/config")
async def get_dashboard_config():
    """대시보드 프로필 설정 반환"""
    settings = get_settings()
    return JSONResponse({
        "user": {
            "name": settings.dash_user_name,
            "id": settings.dash_user_id,
            "hasPortrait": bool(settings.dash_user_portrait),
        },
        "assistant": {
            "name": settings.dash_assistant_name,
            "id": settings.dash_assistant_id,
            "hasPortrait": bool(settings.dash_assistant_portrait),
        },
    })


@router.get("/portrait/{role}")
async def get_portrait(role: str):
    """프로필 초상화 이미지 서빙 (64x64 PNG)"""
    if role not in ("user", "assistant"):
        return Response(status_code=404)

    settings = get_settings()
    path_str = settings.dash_user_portrait if role == "user" else settings.dash_assistant_portrait

    if not path_str:
        return Response(status_code=404)

    # 캐시 확인
    cache_key = f"{role}:{path_str}"
    if cache_key not in _portrait_cache:
        _portrait_cache[cache_key] = _load_and_resize_portrait(path_str)

    data = _portrait_cache[cache_key]
    if data is None:
        return Response(status_code=404)

    return Response(
        content=data,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )
