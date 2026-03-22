"""SQLite + JSONL → PostgreSQL 마이그레이션 CLI 스크립트.

서버와 독립적으로 실행 가능한 수동 이관 도구.
이관 로직은 legacy_migrator 모듈을 공유한다.

사용법:
    python scripts/migrate_to_postgres.py --data-dir /path/to/data --database-url postgresql://... --node-id silent-manari
"""

import argparse
import asyncio
import logging

import asyncpg

from soul_server.service.legacy_migrator import (
    _build_session_folder_map,
    _count_sources,
    _deprecate_files,
    _detect_legacy_files,
    _migrate_catalog,
    _migrate_events,
    _migrate_sessions,
    _verify_migration,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)


async def migrate(data_dir: str, database_url: str, node_id: str, dry_run: bool = False) -> None:
    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=5)
    try:
        legacy = _detect_legacy_files(data_dir)
        if not legacy:
            logger.info("레거시 파일 없음")
            return

        source_counts = _count_sources(legacy)
        logger.info(f"소스 레코드: {source_counts}")

        if dry_run:
            logger.info("[DRY RUN] 실제 이관을 수행하지 않습니다")
            return

        if "catalog" in legacy:
            await _migrate_catalog(pool, legacy["catalog"], node_id)
        if "sessions_db" in legacy:
            sfm = _build_session_folder_map(legacy.get("catalog"))
            await _migrate_sessions(pool, legacy["sessions_db"], node_id, session_folder_map=sfm)
        if "events_dir" in legacy:
            await _migrate_events(pool, legacy["events_dir"], node_id)

        if await _verify_migration(pool, source_counts, node_id):
            _deprecate_files(legacy)
            logger.info("완료: 원본 deprecated")
        else:
            logger.warning("검증 실패: 원본 유지")
    finally:
        await pool.close()


def main():
    parser = argparse.ArgumentParser(description="SQLite/JSONL → PostgreSQL 마이그레이션")
    parser.add_argument("--data-dir", required=True, help="기존 soulstream data 디렉토리")
    parser.add_argument("--database-url", required=True, help="PostgreSQL 연결 문자열")
    parser.add_argument("--node-id", required=True, help="노드 식별자")
    parser.add_argument("--dry-run", action="store_true", help="실제 DB 쓰기 없이 실행")
    args = parser.parse_args()

    asyncio.run(migrate(args.data_dir, args.database_url, args.node_id, args.dry_run))


if __name__ == "__main__":
    main()
