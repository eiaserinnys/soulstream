"""
Catalog API 라우터 — /api/catalog

폴더 + 세션 통합 카탈로그 조회.
"""

import logging

from fastapi import APIRouter

from soul_common.catalog.catalog_service import CatalogService

logger = logging.getLogger(__name__)


def create_catalog_router(catalog_service: CatalogService) -> APIRouter:
    router = APIRouter(prefix="/api/catalog", tags=["catalog"])

    @router.get("")
    async def get_catalog() -> dict:
        """폴더 + 세션 카탈로그 조회."""
        return await catalog_service.get_catalog()

    return router
