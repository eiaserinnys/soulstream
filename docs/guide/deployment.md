# Deployment

Soulstream uses [Haniel](https://github.com/eiaserinnys/haniel) as its process supervisor and release manager. Deployment manifests in `deploy/` separate central PostgreSQL migration authority from database-free remote worker updates.

## Central release manifest vs DB-free worker manifest

The repository defines explicit release contracts so worker rollouts can never mutate the shared PostgreSQL schema:

- **Central orchestrator manifest ([`deploy/release-manifest.json`](../../deploy/release-manifest.json) and [`deploy/database-release-central.json`](../../deploy/database-release-central.json))**: makes the central orchestrator deployment the sole shared database migration authority. It defines preflight checks, writer quiescence verification, schema migration apply, post-start health verification, and release-journal recovery.
- **Remote worker manifest ([`deploy/release-manifest-worker.json`](../../deploy/release-manifest-worker.json))**: keeps remote `soul-server-ts` worker deployments completely database-free. Workers build and restart their local service and verify local health without touching PostgreSQL.
- **Standalone manifest ([`deploy/release-manifest-standalone.json`](../../deploy/release-manifest-standalone.json) and [`deploy/database-release-standalone.json`](../../deploy/database-release-standalone.json))**: provides an explicit release contract for single-host standalone deployments.
- **Haniel worker configuration templates**: [`install/haniel-soul-server-ts.example.yaml`](../../install/haniel-soul-server-ts.example.yaml) serves as the worker-node integration reference, and [`install/haniel-worker.yaml.template`](../../install/haniel-worker.yaml.template) is rendered by the Windows worker installer ([`install/install.ps1`](../../install/install.ps1)).

The central manifest's `service_restart_filters` lets Haniel keep a service running when every changed path matches that service's `ignore_paths` and migration preflight reports `pending_count` of zero or explicitly reports `pending_additive_only: true`. A dependent service still restarts when its `after` dependency restarts; the build hook always runs. Patterns use Python `fnmatchcase`, where `*` also matches `/`. List only paths unrelated to the service's build and runtime, and keep package manifests, the service's dependencies, root `plugins/` and `patches/`, deployment files, pnpm lock and workspace files, and root build scripts outside the filters. `deploy/tests/test_service_restart_filters.py` checks those boundaries against the current workspace dependency graph and real repository files.

## Database migrations through the release path

Normal service starts (`pnpm --dir orch-server-ts start` and `node soul-server-ts/dist/main.js`) never execute DDL or apply pending migrations.

1. **Fresh installations only**: for a brand-new, empty database, run:

```bash
node packages/db-schema/scripts/migrate.mjs fresh-install
```

`fresh-install` applies `packages/db-schema/sql/schema.sql` (or verifies a database that already matches the current manifest) and fails closed if an existing database has pending migrations.

2. **Upgrading existing databases**: all schema upgrades on existing databases run through `packages/db-schema/scripts/release-executor.mjs` under one of two authorities.
   - **Haniel deployments** (the `deploy/` manifest and database contract pairs) work as before: the default `haniel` authority applies the Haniel release manifest and requires Haniel quiescence evidence.
   - **One-line Linux installs without Haniel** use the `linux-systemd-installer` authority, which turns on only when `--manifest` and `--database-contract` are the repository's own [`install/release-manifest-installer.json`](../../install/release-manifest-installer.json) and [`install/database-release-installer.json`](../../install/database-release-installer.json). Environment variables cannot select it. The executor refuses it on non-Linux hosts, when `HANIEL_DEPLOYMENT_JOURNAL`, `HANIEL_QUIESCENCE_RECEIPT` or `HANIEL_NODE_ID` is set, and when the migration target is not the local `soulstream` database. Before a non-additive apply it reads `soulstream-orch.service` and `soulstream-worker.service` from systemd twice, at apply start and again inside the advisory lock before any DDL, and requires both to be stopped. The installer dumps the database before it applies.
3. **Quiescence and checksum lock**: the release executor records an atomic `database-release.json` journal and acquires the PostgreSQL advisory lock before applying the checksum-locked migrations in `packages/db-schema/migration-manifest.json`. It requires quiescence evidence for upgrades with schema work unless every pending migration is recognized as additive and there is no bootstrap or required subphase.
   The `preflight` result reports `pending_count` (planned migrations plus required subphases) and `pending_additive_only`. A nonempty upgrade classified as additive can apply without a stop receipt, allowing overlap and restart filters when supported by Haniel. Unknown or mixed SQL, bootstrap work, required subphases, and older journals retain the quiescence requirement. An empty upgrade skips the migration run and must still pass `verify`. Additive classification does not measure lock duration or resource cost.
4. **Post-start verification and backups**: after migrations succeed and services start, Haniel runs the manifest's post-start readiness checks (including orchestrator `/api/health` and worker `/health` and internal MCP checks). Database backups (such as scheduled `pg_dump` jobs) are operated independently from code deployments.

For full details on migration IDs, writer provenance checks (`deploy/generate_haniel_writer_projection.py` and `deploy/update_database_release_writer_sources.py`), and stored procedure tests, see [`packages/db-schema/README.md`](../../packages/db-schema/README.md).
