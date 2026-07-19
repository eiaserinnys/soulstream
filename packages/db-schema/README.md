# @soulstream/db-schema

Canonical PostgreSQL DDL for Soulstream.

- `sql/schema.sql` is the canonical fresh-install schema. Normal service starts never execute it.
- `migration-manifest.json` is the ordered migration and checksum contract.
- `sql/migrations/` keeps the versioned migration DDL and procedure snapshots.
- `scripts/migrate.mjs` owns preflight, application, recovery, and ledger verification under one PostgreSQL advisory lock.
- `scripts/backup.mjs` creates and verifies a custom-format PostgreSQL archive, and restores it as Haniel's final rollback fallback.
- `tests/test_db_procedures.py` verifies stored procedures directly against PostgreSQL.

`soul-server-ts/scripts/apply-schema.mjs` is fresh-install only. The standalone installer calls the migrator's `initialize` mode once, while `soul-server-ts/scripts/verify-migrations.mjs` is the fail-closed normal `pre_start` hook. Every migration that changes existing objects must still be mirrored in `sql/schema.sql` so a new database reaches the same canonical shape without replaying history.
