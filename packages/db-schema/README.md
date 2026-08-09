# @soulstream/db-schema

Canonical PostgreSQL DDL for Soulstream.

- `sql/schema.sql` is the canonical fresh-install schema. Normal service starts never execute it.
- `migration-manifest.json` is the ordered migration and checksum contract.
- `sql/migrations/` keeps the versioned migration DDL and procedure snapshots.
- `scripts/release-executor.mjs` owns the operation-aware release state machine and the atomic `database-release.json` journal.
- `deploy/database-release-central.json` and `deploy/database-release-standalone.json` are the canonical writer-service and required-subphase contracts. Haniel release manifests reference them through `--database-contract`, keeping Haniel's strict `haniel.release.v1` schema backward compatible while the executor binds the sidecar checksum into its journal identity.
- `deploy/generate_haniel_writer_projection.py` extracts only repository names and service dependency edges from the node-local Haniel source. `deploy/eiaserinnys-haniel-writer-provenance.json` records the full source checksum and deterministic secret-free graph; CI regenerates the loader-complete fixture from that graph. On the owning node, set `HANIEL_LIVE_CONFIG_PATH` and run `python deploy/generate_haniel_writer_projection.py --source "$HANIEL_LIVE_CONFIG_PATH" --fixture soul-server-ts/tests/fixtures/eiaserinnys-haniel-services.yaml --provenance deploy/eiaserinnys-haniel-writer-provenance.json --check` before changing the central service graph. A stale projection also fails closed at runtime because the actual Haniel receipt service set must exactly equal the sidecar.
- `scripts/migrate.mjs` is the deepest SQL writer. It reopens the executor journal under the PostgreSQL advisory lock and refuses mutation unless the recorded identity and `apply_started` phase match.
- Every migration declares `rollback_compatibility`: historical baseline entries are `bootstrap_only`, one-release expand migrations use `previous_release_safe`, and rollback-unsafe changes use `restore_required`. Missing declarations fail manifest loading.
- `scripts/backup.mjs` creates and verifies a custom-format PostgreSQL archive only when the actual pending plan contains a rollback-unsafe migration. A previous-release-safe release records an auditable `verified_not_required` result without running `pg_dump` or `pg_restore`.
- `scripts/postgres-backup-tools.mjs` verifies `pg_dump`/`pg_restore` availability, client/server compatibility, database access, object ownership, and a schema archive probe during migration preflight, before Haniel stops a service.
- `tests/test_db_procedures.py` verifies stored procedures directly against PostgreSQL.

`soul-server-ts/scripts/apply-schema.mjs` is a legacy-compatible executor entrypoint. It may initialize a database only after the full user-object inventory proves zero, and it may verify an already-current database without mutation. An existing database with pending migrations fails closed until Haniel supplies the resident-owner quiescence receipt and operation-aware release identity. Every migration that changes existing objects must still be mirrored in `sql/schema.sql` so a new database reaches the same canonical shape without replaying history.

`deploy/release-manifest.json` pins `environment_service` to
`soulstream-orch-server`. That central Haniel deployment is the single migration
authority for the shared PostgreSQL database: it builds, preflights, stops the
central services, records and verifies the quiescence receipt, backs up and verifies the
archive, takes the migration advisory lock, applies the ordered
manifest, and only then starts services. Worker-only Haniel configurations pin
`deploy/release-manifest-worker.json`, which has no migration or database verification phase.
Workers start after the authority deployment and verify only their HTTP, registry, and MCP
surfaces. This also
prevents Haniel's conventional-manifest auto-discovery from activating the
cluster authority manifest on a worker.

The release manifest uses Haniel's `soulstream.database-release.v1` result contract.
Fresh installation never invokes dump or restore. Upgrade recovery preserves the database
for `previous_release_safe` changes and restores the verified archive for
`restore_required` migrations before Haniel rolls the repository back. With the orchestrator as the only database writer,
Haniel's central service stop is the writer-quiescence boundary. Migration preflight checks
restore capability, and apply revalidates the verified backup gate; no external cluster fence
file is required.
