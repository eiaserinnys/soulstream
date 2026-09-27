# @soulstream/db-schema

Canonical PostgreSQL DDL for Soulstream.

- `sql/schema.sql` is the canonical fresh-install schema. Normal service starts never execute it.
- `migration-manifest.json` is the ordered migration and checksum contract.
- `sql/migrations/` keeps the versioned migration DDL and procedure snapshots.
- `scripts/release-executor.mjs` owns the operation-aware release state machine and the atomic `database-release.json` journal.
- `deploy/database-release-central.json` and `deploy/database-release-standalone.json` are the canonical affected-service and required-subphase contracts. The central and standalone Haniel manifests keep their own explicit `--manifest` and `--database-contract` command arguments because they represent different release contracts; the executor binds the sidecar checksum into its journal identity without extending Haniel's strict `haniel.release.v1` schema.
- `deploy/generate_haniel_writer_projection.py` extracts only repository names and service dependency edges from the node-local Haniel source. `deploy/eiaserinnys-haniel-writer-provenance.json` records the full source checksum and deterministic secret-free graph; CI regenerates the loader-complete fixture from that graph. On the owning node, set `HANIEL_LIVE_CONFIG_PATH` and run `python deploy/generate_haniel_writer_projection.py --source "$HANIEL_LIVE_CONFIG_PATH" --fixture soul-server-ts/tests/fixtures/eiaserinnys-haniel-services.yaml --provenance deploy/eiaserinnys-haniel-writer-provenance.json --check` before changing the central service graph. A stale projection also fails closed at runtime because the actual Haniel receipt service set must exactly equal the sidecar.
- `deploy/database-release-writer-sources.json` pins every checked-in Haniel source used by the database release contract. After changing one of those source files, run `python deploy/update_database_release_writer_sources.py`; CI uses `python deploy/update_database_release_writer_sources.py --check` semantics and reports the source name, path, expected checksum, and actual checksum when a pin is stale.
- `scripts/migrate.mjs` is the deepest SQL writer. It reopens the executor journal under the PostgreSQL advisory lock and refuses mutation unless the recorded identity and `apply_started` phase match.
- Deployment does not classify migrations as destructive. It applies the pending checksum-locked migrations in manifest order. The canonical backup is the independently operated daily 04:00 UTC `pg_dump` cron; deployment neither invokes nor requires that backup.
- `tests/test_db_procedures.py` verifies stored procedures directly against PostgreSQL.

## Migration IDs

The full migration filename, including its descriptive suffix, is the canonical ID. IDs must be unique and sort lexically in apply order. Numeric prefixes can repeat when the full filenames remain distinct; the prefix alone is not an identity. Keep applied migration files and their checksums immutable.

For a new, empty local database, run `node packages/db-schema/scripts/migrate.mjs fresh-install`. Existing databases with pending migrations go through the central Haniel release manifest, which supplies the resident-owner quiescence receipt and operation-aware release identity. `soul-server-ts/scripts/apply-schema.mjs` remains a legacy-compatible wrapper for that executor, not the documented setup path. Every migration that changes existing objects must still be mirrored in `sql/schema.sql` so a new database reaches the same canonical shape without replaying history.

`deploy/release-manifest.json` pins `environment_service` to
`soulstream-orch-server`. That central Haniel deployment is the single migration
authority for the shared PostgreSQL database: it builds, preflights, stops the
central services, records and verifies the quiescence receipt, takes the migration advisory lock, applies the ordered
manifest, and only then starts services. Worker-only Haniel configurations pin
`deploy/release-manifest-worker.json`, which has no migration or database verification phase.
Workers start after the authority deployment and verify only their HTTP, registry, and MCP
surfaces. This also
prevents Haniel's conventional-manifest auto-discovery from activating the
cluster authority manifest on a worker.

The release manifest uses Haniel's `soulstream.database-release.v1` result contract. With the orchestrator as the only database writer, Haniel's central service stop is the affected-service quiescence boundary. Recovery closes the failed release journal without restoring database contents; the daily backup remains operationally independent from deployment.

The worker manifest has no migration phase. Its `recovery.strategy: rollback` describes Haniel's service/code rollback; the configured `recovery.command` repeats the worker health probe and does not restore database contents. Keep database rollback and recovery in the central database release contract.

The production size snapshot and guarded apply procedure for event-search covering-index migrations 101/102 are recorded in [`event-search-covering-index-apply.md`](../../docs/event-search-covering-index-apply.md). The snapshot is time-bounded; the database owner must remeasure disk and WAL headroom before applying.
