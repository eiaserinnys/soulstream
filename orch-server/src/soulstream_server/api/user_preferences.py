"""User preferences API for account-scoped dashboard appearance settings."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, File, HTTPException, Request, Response, UploadFile

from soulstream_server.user_preferences import (
    ALLOWED_BACKGROUND_MIME_TYPES,
    MAX_BACKGROUND_BYTES,
    UserPreferences,
    normalize_user_preferences,
    preferences_from_payload,
    validate_background_mime,
)
from soulstream_server.users import validate_user_email


def create_user_preferences_router(repository, dependencies=None) -> APIRouter:
    router = APIRouter(prefix="/api/user", tags=["user-preferences"], dependencies=dependencies or [])

    @router.get("/preferences")
    async def get_preferences(request: Request) -> dict[str, Any]:
        email = _request_email(request)
        row = await repository.get(email)
        return _serialize_preferences(row)

    @router.put("/preferences")
    async def put_preferences(
        request: Request,
        payload: dict[str, Any] = Body(default_factory=dict),
    ) -> dict[str, Any]:
        email = _request_email(request)
        prefs = preferences_from_payload(payload)
        try:
            row = await repository.put(
                email,
                prefs,
                clear_background=bool(payload.get("clearBackground")),
            )
        except Exception as exc:
            _raise_user_write_error(exc)
        return _serialize_preferences(row)

    @router.post("/background")
    async def upload_background(
        request: Request,
        file: UploadFile = File(...),
    ) -> dict[str, Any]:
        email = _request_email(request)
        mime = _validated_upload_mime(file.content_type)
        blob = await _read_limited_upload(file)
        existing = await repository.get(email)
        prefs = normalize_user_preferences(existing.prefs)
        prefs["wallpaper"] = {
            "mode": "photo",
            "customImage": "/api/user/background",
        }
        try:
            row = await repository.put_background(email, prefs, blob=blob, mime=mime)
        except Exception as exc:
            _raise_user_write_error(exc)
        return _serialize_preferences(row)

    @router.get("/background")
    async def get_background(request: Request) -> Response:
        email = _request_email(request)
        row = await repository.get(email)
        if not row.has_background:
            raise HTTPException(status_code=404, detail="No background image is stored")
        return Response(content=row.background_blob, media_type=row.background_mime)

    @router.delete("/background")
    async def delete_background(request: Request) -> dict[str, Any]:
        email = _request_email(request)
        existing = await repository.get(email)
        prefs = normalize_user_preferences(existing.prefs)
        prefs["wallpaper"] = {"mode": "bokeh"}
        try:
            row = await repository.put(email, prefs, clear_background=True)
        except Exception as exc:
            _raise_user_write_error(exc)
        return _serialize_preferences(row)

    return router


def _request_email(request: Request) -> str:
    auth_user = getattr(request.state, "auth_user", None)
    email = auth_user.get("email") if isinstance(auth_user, dict) else None
    if not email:
        raise HTTPException(
            status_code=401,
            detail="Authenticated user email is required",
        )
    try:
        return validate_user_email(email)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid authenticated user email") from exc


def _serialize_preferences(row: UserPreferences) -> dict[str, Any]:
    prefs = normalize_user_preferences(row.prefs)
    background_url = None
    if row.has_background:
        background_url = "/api/user/background"
        if row.updated_at is not None:
            background_url = f"{background_url}?v={int(row.updated_at.timestamp())}"
        if prefs["wallpaper"]["mode"] == "photo":
            wallpaper = dict(prefs["wallpaper"])
            wallpaper["customImage"] = background_url
            prefs["wallpaper"] = wallpaper

    return {
        "email": row.email,
        "preferences": prefs,
        "appearance": prefs["appearance"],
        "wallpaper": prefs["wallpaper"],
        "hasBackground": row.has_background,
        "backgroundUrl": background_url,
        "updatedAt": row.updated_at.isoformat() if row.updated_at else None,
    }


def _validated_upload_mime(content_type: str | None) -> str:
    try:
        return validate_background_mime(content_type)
    except ValueError as exc:
        raise HTTPException(
            status_code=415,
            detail={
                "error": "UNSUPPORTED_BACKGROUND_MIME",
                "allowed": sorted(ALLOWED_BACKGROUND_MIME_TYPES),
            },
        ) from exc


async def _read_limited_upload(file: UploadFile) -> bytes:
    blob = await file.read(MAX_BACKGROUND_BYTES + 1)
    if len(blob) > MAX_BACKGROUND_BYTES:
        raise HTTPException(
            status_code=413,
            detail={
                "error": "BACKGROUND_TOO_LARGE",
                "maxBytes": MAX_BACKGROUND_BYTES,
            },
        )
    if not blob:
        raise HTTPException(status_code=400, detail="Background image is empty")
    return blob


def _raise_user_write_error(exc: Exception) -> None:
    if exc.__class__.__name__ == "ForeignKeyViolationError":
        raise HTTPException(
            status_code=403,
            detail="Authenticated user is not registered for dashboard access",
        ) from exc
    raise exc
