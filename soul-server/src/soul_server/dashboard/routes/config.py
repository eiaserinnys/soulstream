"""설정 CRUD + 헬스체크 라우터 (/api/health, /api/config, /api/config/settings)"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from soul_server.dashboard.auth import require_dashboard_auth

logger = logging.getLogger(__name__)

router = APIRouter()


# === /api/health ===

@router.get("/api/health")
async def api_health():
    return {"status": "ok"}


# === /api/config ===

@router.get("/api/config")
async def api_config():
    """대시보드 AppConfig — 클라이언트 초기화용.

    unified-dashboard 클라이언트가 /api/config 로 모드·피처 플래그를 조회한다.
    soul-server는 single-node 모드를 반환한다.
    """
    from soul_server.config import get_settings

    settings = get_settings()
    return {
        "mode": "single",
        "nodeId": settings.soulstream_node_id or None,
        "auth": {"enabled": bool(settings.google_client_id)},
        "features": {
            "configModal": True,
            "searchModal": True,
            "nodePanel": False,
            "nodeGuard": True,
        },
    }


# === /api/config/settings ===

class ConfigSettingsUpdateBody(BaseModel):
    changes: dict[str, str]


@router.get(
    "/api/config/settings",
    dependencies=[Depends(require_dashboard_auth)],
)
async def api_config_settings_get():
    """설정 조회 — 카테고리별 그룹핑 + 메타데이터"""
    from soul_server.config import (
        get_settings, SETTINGS_REGISTRY, CATEGORY_LABELS,
    )

    settings = get_settings()

    # 카테고리별 필드 그룹핑
    categories_map: dict[str, list] = {}
    for field_name, meta in SETTINGS_REGISTRY.items():
        value = getattr(settings, field_name, None)
        # csv 타입은 리스트 → 쉼표 구분 문자열로 변환
        if meta.value_type == "csv" and isinstance(value, list):
            value = ",".join(value)
        # sensitive 필드 마스킹
        if meta.sensitive and value and str(value).strip():
            display_value = "********"
        else:
            display_value = value

        field_data = {
            "key": meta.env_key,
            "field_name": field_name,
            "label": meta.label,
            "description": meta.description,
            "value": display_value,
            "value_type": meta.value_type,
            "sensitive": meta.sensitive,
            "hot_reloadable": meta.hot_reloadable,
            "read_only": meta.read_only,
        }

        if meta.category not in categories_map:
            categories_map[meta.category] = []
        categories_map[meta.category].append(field_data)

    # 카테고리 순서 유지 (CATEGORY_LABELS 순서)
    categories = [
        {"name": cat, "label": CATEGORY_LABELS.get(cat, cat), "fields": categories_map[cat]}
        for cat in CATEGORY_LABELS
        if cat in categories_map
    ]

    return {
        "serendipityAvailable": bool(settings.serendipity_url),
        "categories": categories,
    }


@router.put(
    "/api/config/settings",
    dependencies=[Depends(require_dashboard_auth)],
)
async def api_config_settings_put(body: ConfigSettingsUpdateBody):
    """설정 업데이트 — .env 쓰기 + 핫리로드"""
    from pathlib import Path
    from dotenv import load_dotenv, set_key
    from soul_server.config import (
        get_settings, SETTINGS_REGISTRY,
    )

    dotenv_path = str(Path.cwd() / ".env")
    applied: list[str] = []
    restart_required: list[str] = []
    errors: list[str] = []

    # env_key → field_name 역매핑
    env_key_to_field: dict[str, str] = {
        meta.env_key: field_name
        for field_name, meta in SETTINGS_REGISTRY.items()
    }

    for env_key, new_value in body.changes.items():
        field_name = env_key_to_field.get(env_key)
        if field_name is None:
            errors.append(f"Unknown setting: {env_key}")
            continue

        meta = SETTINGS_REGISTRY[field_name]
        if meta.read_only:
            errors.append(f"Read-only setting: {env_key}")
            continue

        # .env 파일에 기록
        try:
            set_key(dotenv_path, env_key, new_value)
        except Exception as e:
            errors.append(f"Failed to write {env_key}: {e}")
            continue

        if meta.hot_reloadable:
            applied.append(env_key)
        else:
            restart_required.append(env_key)

    if errors and not applied and not restart_required:
        raise HTTPException(status_code=400, detail={"errors": errors})

    # .env 리로드 + Settings 캐시 무효화
    load_dotenv(dotenv_path=dotenv_path, override=True)
    get_settings.cache_clear()

    return {
        "applied": applied,
        "restart_required": restart_required,
        "errors": errors,
    }
