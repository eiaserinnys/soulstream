"""레거시 데이터 마이그레이션 패키지.

서버 기동 시 레거시 데이터(SQLite/JSONL) → PostgreSQL 자동 이관을 담당한다.
마이그레이션 완료 후 이 패키지 전체를 제거하면 메인 패키지에서 분리된다.
"""

from soul_server.migration.legacy_migrator import (
    DryRunReport,
    auto_migrate,
    auto_migrate_dry_run,
)

__all__ = ["auto_migrate", "auto_migrate_dry_run", "DryRunReport"]
