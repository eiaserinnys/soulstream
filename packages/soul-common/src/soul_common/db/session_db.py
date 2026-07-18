"""
PostgresSessionDB - PostgreSQL 기반 세션 저장소 (thin assembly class)

6개 도메인 mixin(session_crud, events, viewport, folders, tasks, search)을 합성하여
SessionDBBase 인터페이스를 구현한다.

인프라 관심사(connect/close/pool)만 이 파일에 남긴다.
도메인 로직은 soul_common.db.postgres.* 모듈에서 구현한다.

인터페이스 정본은 SessionDBBase(session_db_base.py)에 정의되어 있다.
메서드를 추가·삭제·시그니처 변경할 때는 SessionDBBase를 먼저 수정한다.
"""

import logging
from pathlib import Path
from typing import Optional

import asyncpg

from soul_common.db.session_db_base import SessionDBBase
from soul_common.db.postgres.session_crud import PostgresSessionCRUDMixin
from soul_common.db.postgres.events import PostgresEventMixin
from soul_common.db.postgres.viewport import PostgresViewportMixin
from soul_common.db.postgres.folders import PostgresFolderMixin
from soul_common.db.postgres.tasks import PostgresTaskMixin
from soul_common.db.postgres.search import PostgresSearchMixin
from soul_common.db.postgres.supervisor import PostgresSupervisorMixin

logger = logging.getLogger(__name__)


class PostgresSessionDB(
    PostgresSupervisorMixin,
    PostgresSessionCRUDMixin,
    PostgresEventMixin,
    PostgresViewportMixin,
    PostgresFolderMixin,
    PostgresTaskMixin,
    PostgresSearchMixin,
    SessionDBBase,
):
    """PostgreSQL 기반 세션 저장소

    6개 도메인 mixin이 SessionDBBase의 모든 추상 메서드를 구현한다.
    이 클래스는 인프라(connect/close/pool)만 담당한다.

    Args:
        database_url: PostgreSQL 접속 URL
        node_id: 노드 식별자. None이면 전역 뷰 (오케스트레이터용)
        schema_path: DDL 파일 경로. None이면 스키마 배포 생략.
    """

    def __init__(
        self,
        database_url: str,
        node_id: Optional[str] = None,
        schema_path: Optional[Path] = None,
    ):
        self._database_url = database_url
        self._node_id = node_id
        self._schema_path = schema_path
        self._pool: Optional[asyncpg.Pool] = None

    @property
    def node_id(self) -> Optional[str]:
        return self._node_id

    @property
    def pool(self) -> asyncpg.Pool:
        """연결 풀 반환. connect() 전 호출 시 RuntimeError."""
        if self._pool is None:
            raise RuntimeError("connect()를 먼저 호출하세요")
        return self._pool

    async def connect(self) -> None:
        """연결 풀 생성 및 검증. 실패 시 예외 → 서버 기동 중단."""
        self._pool = await asyncpg.create_pool(
            self._database_url,
            min_size=2,
            max_size=10,
            command_timeout=30,
        )
        async with self._pool.acquire() as conn:
            await conn.execute("SELECT 1")
        if self._schema_path is not None:
            await self._apply_schema()
        logger.info("PostgreSQL connection pool established")

    async def _apply_schema(self) -> None:
        """DDL 정본 파일을 실행하여 스키마와 프로시저를 배포한다.

        실패 시 예외 → 서버 기동 중단.
        """
        if self._schema_path is None:
            return
        sql = self._schema_path.read_text(encoding="utf-8")
        await self._pool.execute(sql)
        logger.info("Schema and procedures deployed from %s", self._schema_path.name)

    async def close(self) -> None:
        if self._pool:
            await self._pool.close()

    # extract_searchable_text는 SessionDBBase에서 상속 (하위 호환 staticmethod)
