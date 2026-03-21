#!/usr/bin/env python3
"""기존 이벤트의 searchable_text를 재생성하고 FTS5 인덱스를 재구축한다.

서버 중지 상태에서 실행해야 한다 (SQLite WAL 잠금 방지).

Usage:
    python scripts/reindex_fts.py [--db PATH] [--dry-run]

Options:
    --db PATH    soulstream.db 경로 (기본: ../../../services/soulstream/data/soulstream.db)
    --dry-run    실제 변경 없이 변경될 행 수만 출력
"""

import argparse
import json
import sqlite3
import sys
from pathlib import Path

# SessionDB.extract_searchable_text를 직접 import
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from soul_server.service.session_db import SessionDB


def reindex(db_path: str, dry_run: bool = False) -> None:
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row

    total = db.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    print(f"Total events: {total}")

    # 변경이 필요한 행을 배치로 처리
    updated = 0
    skipped = 0
    batch_size = 500
    offset = 0

    while True:
        rows = db.execute(
            "SELECT id, session_id, event_type, payload FROM events "
            "ORDER BY id LIMIT ? OFFSET ?",
            (batch_size, offset),
        ).fetchall()

        if not rows:
            break

        for row in rows:
            try:
                event = json.loads(row["payload"])
            except (json.JSONDecodeError, TypeError):
                skipped += 1
                continue

            new_text = SessionDB.extract_searchable_text(event)
            old_text = db.execute(
                "SELECT searchable_text FROM events WHERE id = ?", (row["id"],)
            ).fetchone()[0]

            if new_text != old_text:
                if not dry_run:
                    db.execute(
                        "UPDATE events SET searchable_text = ? WHERE id = ?",
                        (new_text, row["id"]),
                    )
                updated += 1

        offset += batch_size
        if not dry_run and updated > 0:
            db.commit()

        # 진행 표시
        processed = min(offset, total)
        print(f"  processed {processed}/{total} ({updated} updated)", end="\r")

    print()

    if not dry_run and updated > 0:
        # FTS5 인덱스 재구축
        print("Rebuilding FTS5 index...")
        db.execute("INSERT INTO events_fts(events_fts) VALUES('rebuild')")
        db.commit()

    mode = "DRY RUN" if dry_run else "DONE"
    print(f"[{mode}] {updated} rows updated, {skipped} skipped (parse error)")
    db.close()


def main():
    parser = argparse.ArgumentParser(description="Reindex FTS5 searchable_text")
    default_db = str(
        Path(__file__).resolve().parent.parent.parent.parent
        / "services"
        / "soulstream"
        / "data"
        / "soulstream.db"
    )
    parser.add_argument("--db", default=default_db, help="soulstream.db path")
    parser.add_argument(
        "--dry-run", action="store_true", help="Show changes without applying"
    )
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"DB not found: {db_path}")
        sys.exit(1)

    print(f"DB: {db_path}")
    print(f"Mode: {'dry-run' if args.dry_run else 'live'}")
    print()
    reindex(str(db_path), dry_run=args.dry_run)


if __name__ == "__main__":
    main()
