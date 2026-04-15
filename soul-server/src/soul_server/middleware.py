"""순수 ASGI 미들웨어 모듈

main.py에서 분리된 미들웨어 클래스.
BaseHTTPMiddleware 대신 순수 ASGI로 구현하여 SSE 스트리밍과의 충돌을 방지한다.
"""

from pathlib import Path
from typing import Callable

from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Scope, Receive, Send


class CheckDrainingMiddleware:
    """드레이닝 중 신규 세션 실행 요청을 거부하는 순수 ASGI 미들웨어.

    Args:
        app: ASGI 앱
        is_draining_fn: 드레이닝 상태를 반환하는 콜백
    """

    def __init__(self, app: ASGIApp, *, is_draining_fn: Callable[[], bool]) -> None:
        self.app = app
        self._is_draining = is_draining_fn

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] == "http"
            and self._is_draining()
            and scope.get("path") == "/execute"
        ):
            response = JSONResponse(
                {"error": "server_draining", "message": "서버 재시작 중입니다. 잠시 후 다시 시도하세요."},
                status_code=503,
            )
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)


class SPAFallbackMiddleware:
    """SPA fallback — /api/* 이외의 GET 요청에서 404 발생 시 index.html을 반환한다.

    Args:
        app: ASGI 앱
        dashboard_dir: 대시보드 정적 파일 디렉토리 경로
    """

    def __init__(self, app: ASGIApp, *, dashboard_dir: str) -> None:
        self.app = app
        self._dashboard_dir = dashboard_dir

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # WebSocket이나 non-GET 요청, /api/* 요청은 그대로 패스스루
        if (
            scope["type"] != "http"
            or scope.get("method") != "GET"
            or scope.get("path", "").startswith("/api/")
        ):
            await self.app(scope, receive, send)
            return

        response_status: int | None = None
        start_message: dict | None = None

        async def intercept_send(message: dict) -> None:
            nonlocal response_status, start_message
            if message["type"] == "http.response.start":
                response_status = message["status"]
                if response_status != 404:
                    await send(message)  # non-404: 즉시 패스스루 (SSE 안전)
                else:
                    start_message = message  # 404: start 메시지 버퍼링
            elif message["type"] == "http.response.body":
                if response_status != 404:
                    await send(message)  # non-404: 즉시 패스스루
                # 404 body는 버려짐 (index.html로 대체)
            else:
                await send(message)  # 기타 메시지 패스스루

        await self.app(scope, receive, intercept_send)

        # 404였으면 index.html로 폴백
        if response_status == 404:
            _d = self._dashboard_dir
            _p = Path(_d) if Path(_d).is_absolute() else Path.cwd() / _d
            _idx = _p / "index.html"
            if _idx.exists():
                from starlette.responses import HTMLResponse

                fallback = HTMLResponse(
                    _idx.read_text(),
                    headers={"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache"},
                )
                await fallback(scope, receive, send)
                return
            # index.html 없음: 원래 404 응답 그대로 반환
            if start_message is not None:
                await send(start_message)
            await send({"type": "http.response.body", "body": b"", "more_body": False})
