# Deployment

Soulstream uses [Haniel](https://github.com/eiaserinnys/haniel) as its process supervisor and release manager. Deployment manifests in `deploy/` separate central PostgreSQL migration authority from database-free remote worker updates.

## Central release manifest vs DB-free worker manifest

The repository defines explicit release contracts so worker rollouts can never mutate the shared PostgreSQL schema:

- **Central orchestrator manifest ([`deploy/release-manifest.json`](../../deploy/release-manifest.json) and [`deploy/database-release-central.json`](../../deploy/database-release-central.json))**: makes the central orchestrator deployment the sole shared database migration authority. It defines preflight checks, writer quiescence verification, schema migration apply, post-start health verification, and release-journal recovery.
- **Remote worker manifest ([`deploy/release-manifest-worker.json`](../../deploy/release-manifest-worker.json))**: keeps remote `soul-server-ts` worker deployments completely database-free. Workers build and restart their local service and verify local health without touching PostgreSQL.
- **Standalone manifest ([`deploy/release-manifest-standalone.json`](../../deploy/release-manifest-standalone.json) and [`deploy/database-release-standalone.json`](../../deploy/database-release-standalone.json))**: provides an explicit release contract for single-host standalone deployments.
- **Haniel worker configuration templates**: [`install/haniel-soul-server-ts.example.yaml`](../../install/haniel-soul-server-ts.example.yaml) serves as the worker-node integration reference, and [`install/haniel-worker.yaml.template`](../../install/haniel-worker.yaml.template) is rendered by the Windows worker installer ([`install/install.ps1`](../../install/install.ps1)).

## Database migrations through the release path

Normal service starts (`pnpm --dir orch-server-ts start` and `node soul-server-ts/dist/main.js`) never execute DDL or apply pending migrations.

1. **Fresh installations only**: for a brand-new, empty database, run:

```bash
node packages/db-schema/scripts/migrate.mjs fresh-install
```

`fresh-install` applies `packages/db-schema/sql/schema.sql` (or verifies a database that already matches the current manifest) and fails closed if an existing database has pending migrations.

2. **Upgrading existing databases**: all schema upgrades on existing databases run through the central Haniel release manifest and `packages/db-schema/scripts/release-executor.mjs`.
3. **Quiescence and checksum lock**: before applying migrations listed in `packages/db-schema/migration-manifest.json`, the release executor verifies that all database writer services declared in the database release contract are quiesced, records an atomic `database-release.json` journal, and acquires the PostgreSQL advisory lock before invoking `packages/db-schema/scripts/migrate.mjs`.
4. **Post-start verification and backups**: after migrations succeed and services start, Haniel runs the manifest's post-start readiness checks (including orchestrator `/api/health` and worker `/health` and internal MCP checks). Database backups (such as scheduled `pg_dump` jobs) are operated independently from code deployments.

For full details on migration IDs, writer provenance checks (`deploy/generate_haniel_writer_projection.py` and `deploy/update_database_release_writer_sources.py`), and stored procedure tests, see [`packages/db-schema/README.md`](../../packages/db-schema/README.md).
