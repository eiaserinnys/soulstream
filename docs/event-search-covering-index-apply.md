# Event search covering index apply note

This note is for the central database owner applying migrations 101 and 102. Do not run production DDL from an application worker.

## Apply behavior

The migration runner applies pending SQL and ledger rows in one transaction under the database migration advisory lock (`packages/db-schema/scripts/migrate.mjs:173-200`). Migration 101 uses ordinary `CREATE INDEX` because the runner is transactional; PostgreSQL does not allow `CREATE INDEX CONCURRENTLY` inside that transaction. The ordinary build blocks table writes until the release transaction ends. The central release stops the database writer services before applying the manifest (`deploy/release-manifest.json`, `deploy/database-release-central.json`).

The central `apply-migrations-and-board-yjs-residue` command has a 300 second outer timeout. This bounds the entire release apply command; it is not a per-index build budget. The new index's production build duration has not been measured. Check the release window and current disk and WAL headroom immediately before apply. Do not raise this timeout as a substitute for a safe window.

Migration 101 builds a staging index inside the transaction, verifies the exact table, access method, key/include columns, collation, operator class, and valid/ready/live state, then drops the old term-only index and renames the covering index. The database transaction keeps the old index if create or validation fails. A pre-existing staging index makes the migration stop before changing either named index; inspect `pg_index.indisvalid`, `indisready`, and `indislive` and resolve that object through the database owner. Do not edit `schema_migrations` directly. If deployment fails before commit, the transaction rolls back both the DDL and ledger update. After a successful commit, application rollback may leave the covering index in place; reverting the physical index requires a later forward migration that builds and validates the replacement before dropping the current index.

## Read-only production size snapshot

Measured 2026-09-24 08:41:43 UTC, after the separately authorized visibility vacuum, in a read-only transaction. These are a snapshot, not a guarantee for the eventual apply:

| Measurement | Bytes |
|---|---:|
| Database | 28,773,396,963 |
| `event_search_terms` heap | 3,462,250,496 |
| `event_search_terms` indexes, total | 4,601,896,960 |
| `event_search_terms` total relation | 8,065,130,496 |
| Existing term-only index | 355,409,920 |
| Existing primary-key index | 4,246,487,040 |
| `pgdata` filesystem free | 325,137,252,352 |

The table had about 37.77 million live postings. PostgreSQL reported `maintenance_work_mem=65536kB`, `max_parallel_maintenance_workers=2`, and `max_wal_size=8192MB`. The new index's size and build duration are unknown. The read-only database role could not inspect `pg_wal` contents, so WAL occupancy was not measured. `max_wal_size` is a checkpoint target, not a hard cap. INCLUDE columns disable B-tree deduplication and increase index tuple size; do not estimate the new size or elapsed time from the old 355 MB term index or the synthetic fixture.

Before apply, remeasure the actual PostgreSQL data volume's free bytes, current relation and index sizes, and WAL directory usage from an authorized host context. Confirm that free space covers the old index retained during the build, the new index, temporary build files, and WAL growth with operational headroom. If WAL use or remaining storage cannot be established, stop and report it rather than treating the snapshot as current. Record the pre-apply measurements and post-apply index size/build duration in the deployment result.

## Separate autovacuum setting

Migration 102 sets `autovacuum_vacuum_insert_scale_factor=0.05` only for `event_search_terms`; the fresh schema has the same reloption. This is visibility-map maintenance for the high-insert table. It is not the BM25 scoring fix, and it does not replace post-deploy search acceptance measurements.
