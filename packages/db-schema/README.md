# @soulstream/db-schema

Canonical PostgreSQL DDL for Soulstream.

- `sql/schema.sql` is the canonical fresh-install schema. Normal service starts never execute it.
- `migration-manifest.json` is the ordered migration and checksum contract.
- `sql/migrations/` keeps the versioned migration DDL and procedure snapshots.
- `scripts/migrate.mjs` owns preflight, application, recovery, and ledger verification under one PostgreSQL advisory lock.
- `scripts/backup.mjs` creates and verifies a custom-format PostgreSQL archive only when the actual pending plan contains destructive migrations. A non-destructive release records an auditable `verified_not_required` result without running `pg_dump` or `pg_restore`.
- `scripts/postgres-backup-tools.mjs` verifies `pg_dump`/`pg_restore` availability, client/server compatibility, database access, object ownership, and a schema archive probe during migration preflight, before Haniel stops a service.
- `tests/test_db_procedures.py` verifies stored procedures directly against PostgreSQL.

`soul-server-ts/scripts/apply-schema.mjs` is a legacy-compatible `initialize` entrypoint. It executes the canonical schema only for an empty database, safely bootstraps the ledger for an already-current database, and fails closed on a pending destructive migration unless the migration preflight and verified backup gate are satisfied. The standalone installer calls the same `initialize` mode once, while `soul-server-ts/scripts/verify-migrations.mjs` is the normal fail-closed `pre_start` hook. Every migration that changes existing objects must still be mirrored in `sql/schema.sql` so a new database reaches the same canonical shape without replaying history.

Automatic full-database restore is deliberately absent from `deploy/release-manifest.json`. A `pg_restore --clean` recovery is destructive and is rejected unless `SOULSTREAM_CLUSTER_WRITE_FENCE_PATH` names a verified fence for every cluster writer, with zero active writers and the same release/head. Normal release recovery therefore uses data-preserving roll-forward; a local process stop is not treated as cluster-wide quiescence.
