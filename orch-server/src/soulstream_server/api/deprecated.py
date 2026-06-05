"""Deprecated API response helpers."""

from __future__ import annotations

from fastapi.responses import JSONResponse


DEPRECATED_API_CODE = "DEPRECATED_API_PATH"
DESKTOP_ACTION_HARD_RELOAD = "hard-reload"


def deprecated_api_response(
    *,
    deprecated_path: str,
    replacement_path: str,
    replacement_method: str,
    message: str | None = None,
) -> JSONResponse:
    """Return explicit 410 guidance for stale desktop/web bundles."""
    return JSONResponse(
        status_code=410,
        headers={
            "X-Soulstream-Deprecated-Path": deprecated_path,
            "X-Soulstream-Replacement-Path": replacement_path,
            "X-Soulstream-Desktop-Action": DESKTOP_ACTION_HARD_RELOAD,
            "Cache-Control": "no-store",
        },
        content={
            "error": {
                "code": DEPRECATED_API_CODE,
                "message": message
                or f"Deprecated API path. Use {replacement_method} {replacement_path}.",
                "deprecatedPath": deprecated_path,
                "replacementPath": replacement_path,
                "replacementMethod": replacement_method,
                "desktopAction": DESKTOP_ACTION_HARD_RELOAD,
            }
        },
    )
