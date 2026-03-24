"""
대시보드 정적 파일 서빙 — SPA fallback 포함.
"""

import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from starlette.staticfiles import StaticFiles

logger = logging.getLogger(__name__)


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

        # 404인 GET 요청이고 API/WS 경로가 아니면 index.html 반환
        if (
            response.status_code == 404
            and request.method == "GET"
            and not request.url.path.startswith("/api/")
            and not request.url.path.startswith("/ws/")
            and not request.url.path.startswith("/assets/")
        ):
            return FileResponse(str(index_html))

        return response

    logger.info("Dashboard mounted from %s", dashboard_dir)
