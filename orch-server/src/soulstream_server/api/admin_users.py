"""Admin dashboard user management API."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from soul_common.auth.caller_info import decode_dashboard_jwt_user
from soul_common.catalog.catalog_service import CatalogService
from soulstream_server.config import get_settings
from soulstream_server.users import DashboardUserService, normalize_folder_ids, validate_user_email

_UNSET = object()


class UserCreateRequest(BaseModel):
    email: str
    displayName: str | None = None
    isAdmin: bool = False
    allowedFolderIds: list[str] = Field(default_factory=list)

    @field_validator("email")
    @classmethod
    def _validate_email(cls, value: str) -> str:
        return validate_user_email(value)

    @field_validator("allowedFolderIds")
    @classmethod
    def _validate_folder_ids(cls, value: list[str]) -> list[str]:
        return list(normalize_folder_ids(value))


class UserPatchRequest(BaseModel):
    displayName: str | None = None
    isAdmin: bool | None = None
    allowedFolderIds: list[str] | None = None

    @field_validator("allowedFolderIds")
    @classmethod
    def _validate_folder_ids(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        return list(normalize_folder_ids(value))


def _field_supplied(model: BaseModel, field_name: str) -> bool:
    fields = getattr(model, "model_fields_set", None)
    if fields is None:
        fields = getattr(model, "__fields_set__", set())
    return field_name in fields


def _current_email(request: Request) -> str:
    auth_user = getattr(request.state, "auth_user", None)
    if not isinstance(auth_user, dict):
        settings = get_settings()
        auth_user = decode_dashboard_jwt_user(request, settings.jwt_secret or "")
    email = auth_user.get("email") if isinstance(auth_user, dict) else None
    try:
        return validate_user_email(email or "")
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Authentication required") from exc


def _require_admin(request: Request, user_service: DashboardUserService) -> str:
    email = _current_email(request)
    if not user_service.is_admin_email(email):
        raise HTTPException(status_code=403, detail="Admin access required")
    return email


async def _broadcast_access_change(catalog_service: CatalogService) -> None:
    await catalog_service.broadcast_catalog()


def create_admin_users_router(
    user_service: DashboardUserService,
    catalog_service: CatalogService,
    dependencies: list | None = None,
) -> APIRouter:
    router = APIRouter(
        prefix="/api/admin/users",
        tags=["admin-users"],
        dependencies=dependencies or [],
    )

    @router.get("")
    async def list_users(request: Request) -> dict[str, Any]:
        _require_admin(request, user_service)
        users = [user.to_api() for user in await user_service.list_users()]
        folders = await catalog_service.list_folders()
        return {"users": users, "folders": folders}

    @router.post("", status_code=201)
    async def create_user(body: UserCreateRequest, request: Request) -> dict[str, Any]:
        admin_email = _require_admin(request, user_service)
        try:
            user = await user_service.create_user(
                email=body.email,
                display_name=body.displayName,
                is_admin=body.isAdmin,
                allowed_folder_ids=body.allowedFolderIds,
                created_by=admin_email,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        await _broadcast_access_change(catalog_service)
        return {"user": user.to_api()}

    @router.patch("/{email}")
    async def update_user(email: str, body: UserPatchRequest, request: Request) -> dict[str, Any]:
        admin_email = _require_admin(request, user_service)
        target_email = validate_user_email(email)
        if (
            target_email == admin_email
            and _field_supplied(body, "isAdmin")
            and body.isAdmin is False
            and not await user_service.can_remove_admin(target_email)
        ):
            raise HTTPException(status_code=400, detail="At least one admin user is required")

        try:
            user = await user_service.update_user(
                target_email,
                display_name=body.displayName if _field_supplied(body, "displayName") else _UNSET,
                is_admin=body.isAdmin if _field_supplied(body, "isAdmin") else _UNSET,
                allowed_folder_ids=body.allowedFolderIds if _field_supplied(body, "allowedFolderIds") else _UNSET,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="User not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        await _broadcast_access_change(catalog_service)
        return {"user": user.to_api()}

    @router.delete("/{email}")
    async def delete_user(email: str, request: Request) -> dict[str, bool]:
        admin_email = _require_admin(request, user_service)
        target_email = validate_user_email(email)
        if target_email == admin_email and not await user_service.can_remove_admin(target_email):
            raise HTTPException(status_code=400, detail="At least one admin user is required")
        try:
            await user_service.delete_user(target_email)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="User not found") from exc
        await _broadcast_access_change(catalog_service)
        return {"success": True}

    return router
