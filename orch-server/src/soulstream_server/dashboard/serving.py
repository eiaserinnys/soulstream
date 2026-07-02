"""
대시보드 정적 파일 서빙 — SPA fallback 포함.
"""

import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from starlette.responses import Response
from starlette.staticfiles import StaticFiles

logger = logging.getLogger(__name__)

INDEX_CACHE_CONTROL = "no-cache"
ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable"


def _with_cache_control(response: Response, cache_control: str) -> Response:
    response.headers["Cache-Control"] = cache_control
    return response


def _dashboard_file_response(path: Path, cache_control: str) -> Response:
    return _with_cache_control(FileResponse(str(path)), cache_control)


def mount_dashboard(app: FastAPI, dashboard_dir: str) -> None:
    """대시보드 정적 파일 서빙을 설정한다.

    1. /assets 경로에 StaticFiles 마운트
    2. API/WS가 아닌 모든 경로에 index.html fallback (SPA)
    """
    dashboard_path = Path(dashboard_dir)
    if not dashboard_path.exists():
        logger.warning("Dashboard directory not found: %s", dashboard_dir)
        return

    index_html = dashboard_path / "index.html"
    if not index_html.exists():
        logger.warning("index.html not found in dashboard: %s", dashboard_dir)
        return

    # /assets 정적 파일 마운트
    assets_dir = dashboard_path / "assets"
    if assets_dir.exists():
        app.mount(
            "/assets",
            StaticFiles(directory=str(assets_dir)),
            name="dashboard-assets",
        )

    # SPA fallback: API, WS, 정적 파일이 아닌 모든 GET 요청에 index.html 반환
    @app.middleware("http")
    async def spa_fallback(request: Request, call_next):
        response = await call_next(request)
        request_path = request.url.path

        if request_path.startswith("/assets/") and response.status_code < 400:
            return _with_cache_control(response, ASSET_CACHE_CONTROL)

        # 404인 GET 요청이고 API/WS 경로가 아니면 정적 파일 또는 index.html 반환
        if (
            response.status_code == 404
            and request.method == "GET"
            and not request_path.startswith("/api/")
            and not request_path.startswith("/ws/")
            and not request_path.startswith("/assets/")
        ):
            # dist 루트의 정적 파일(PWA: registerSW.js, manifest.webmanifest, sw.js 등) 직접 서빙
            # dashboard_path는 mount_dashboard 함수 스코프의 변수 (L21: dashboard_path = Path(dashboard_dir))
            relative_path = request_path.lstrip("/")
            if relative_path:
                static_file = dashboard_path / relative_path
                if static_file.exists() and static_file.is_file():
                    if static_file == index_html:
                        return _dashboard_file_response(static_file, INDEX_CACHE_CONTROL)
                    return FileResponse(str(static_file))
            # 실제 파일이 없으면 SPA fallback
            return _dashboard_file_response(index_html, INDEX_CACHE_CONTROL)

        return response

    logger.info("Dashboard mounted from %s", dashboard_dir)
