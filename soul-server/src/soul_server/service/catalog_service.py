"""
CatalogService — soul-common re-export 래퍼

본체는 soul_common.catalog.catalog_service에 위치한다.
DI 함수(init/get)는 soul-server 내부 전용이므로 여기에 유지한다.
"""

from typing import Optional

from soul_common.catalog.catalog_service import (  # noqa: F401
    CatalogService,
    SessionBroadcasterProtocol,
)
from soul_common.db.session_db import PostgresSessionDB
from soul_server.service.session_broadcaster import SessionBroadcaster


# ---------------------------------------------------------------------------
# 글로벌 접근자 — get_session_db() 패턴과 동일
# ---------------------------------------------------------------------------

_catalog_service: Optional[CatalogService] = None


def init_catalog_service(
    session_db: PostgresSessionDB,
    broadcaster: SessionBroadcaster,
) -> CatalogService:
    """CatalogService 싱글톤을 초기화한다. main.py lifespan에서 호출."""
    global _catalog_service
    _catalog_service = CatalogService(session_db, broadcaster)
    return _catalog_service


def get_catalog_service() -> CatalogService:
    """초기화된 CatalogService 싱글톤을 반환한다."""
    if _catalog_service is None:
        raise RuntimeError(
            "CatalogService not initialized. Call init_catalog_service() first."
        )
    return _catalog_service
