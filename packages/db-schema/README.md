# @soulstream/db-schema

Canonical PostgreSQL DDL for Soulstream.

- `sql/schema.sql` is the canonical fresh-install schema. Normal service starts never execute it.
- `migration-manifest.json` is the ordered migration and checksum contract.
- `sql/migrations/` keeps the versioned migration DDL and procedure snapshots.
- `scripts/migrate.mjs` owns preflight, application, recovery, and ledger verification under one PostgreSQL advisory lock.
- Every migration declares `rollback_compatibility`: historical baseline entries are `bootstrap_only`, one-release expand migrations use `previous_release_safe`, and rollback-unsafe changes use `restore_required`. Missing declarations fail manifest loading.
- `scripts/backup.mjs` creates and verifies a custom-format PostgreSQL archive only when the actual pending plan contains a rollback-unsafe migration. A previous-release-safe release records an auditable `verified_not_required` result without running `pg_dump` or `pg_restore`.
- `scripts/postgres-backup-tools.mjs` verifies `pg_dump`/`pg_restore` availability, client/server compatibility, database access, object ownership, and a schema archive probe during migration preflight, before Haniel stops a service.
- `tests/test_db_procedures.py` verifies stored procedures directly against PostgreSQL.

`soul-server-ts/scripts/apply-schema.mjs` is a legacy-compatible `initialize` entrypoint. It executes the canonical schema only for an empty database, safely bootstraps the ledger for an already-current database, and fails closed on a pending destructive migration unless the migration preflight and verified backup gate are satisfied. The standalone installer calls the same `initialize` mode once; normal migration execution remains owned by the central release manifest. Every migration that changes existing objects must still be mirrored in `sql/schema.sql` so a new database reaches the same canonical shape without replaying history.

`deploy/release-manifest.json` pins `environment_service` to
`soulstream-orch-server`. That central Haniel deployment is the single migration
authority for the shared PostgreSQL database: it builds, preflights, stops the
central services, takes the migration advisory lock, applies the ordered
manifest, and only then starts services. Worker-only Haniel configurations pin
`deploy/release-manifest-worker.json`, which has no migration or database verification phase.
Workers start after the authority deployment and verify only their HTTP, registry, and MCP
surfaces. This also
prevents Haniel's conventional-manifest auto-discovery from activating the
cluster authority manifest on a worker.

The release manifest always has a previous-release fallback. For an empty or
`previous_release_safe` pending plan the fallback preserves the database and only
lets Haniel roll code back. For `restore_required` migrations it restores the
verified archive before code rollback. With the orchestrator as the only database writer,
Haniel's central service stop is the writer-quiescence boundary. Migration preflight checks
restore capability, and apply revalidates the verified backup gate; no external cluster fence
file is required.
