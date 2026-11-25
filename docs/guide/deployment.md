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

## Promoting the verified `beta` channel

The one-line Linux installer installs the `beta` branch of both the Soulstream and atom repositories unless `--ref` and `--atom-ref` are given. Move `beta` forward only to a pair of commits that passed the checks below on disposable Debian 13 (`x86_64`) VMs of at least 2 vCPU, 4 GB RAM, and 40 GB disk. Run the VMs one at a time.

1. **Pick the candidate.** Choose one commit from `origin/main` in each repository (`SOULSTREAM_SHA` and `ATOM_SHA`, full 40-character SHAs) and confirm that CI passed on both.
2. **Check a new installation.** On a new VM, as `root`, download `install.sh` from the candidate commit and run it with both candidate SHAs:
   ```bash
   curl -fsSL "https://raw.githubusercontent.com/eiaserinnys/soulstream/${SOULSTREAM_SHA}/install/install.sh" -o /tmp/install.sh
   bash /tmp/install.sh --backends claude,codex --ref "$SOULSTREAM_SHA" --atom-ref "$ATOM_SHA" --admin-password-file /root/.ss-pass
   ```
   Confirm all of the following:
   - exit code `0`
   - `/home/soulstream/soulstream/.local/install-state.json` has `status` `completed` and both `current_sha` values equal the candidate SHAs
   - `soulstream-atom`, `soulstream-orch`, and `soulstream-worker` are `active`
   - HTTP `200` from `/api/health` on `:5200` and `:4200`, and from `/health` on `:4205`
   - the `local` node is `connected`
   - administrator password login works on both `:5200` and `:4200`
   - `/persistent` renders in a browser

   Save the result as a record file by copying `install-state.json` to a place outside the VM (for example `fresh-install-state.json`). Step 5 asserts this file. If step 4 requires a person, do it on this VM before deleting it.
3. **Check an update.** If `beta` already exists, repeat on a second new VM: install first with `--ref` and `--atom-ref` set to the two SHAs that `beta` points to now, then run the command from step 2 again with the candidate SHAs. Confirm exit code `0`, `status` `completed`, `previous_sha` equal to the previous `beta` for both repositories, both `current_sha` values equal to the candidate, the three services `active`, and administrator login. Copy `install-state.json` to a record file (for example `update-install-state.json`); its `previous_sha` values are the previous `beta` SHAs you used.
4. **Check the first request by hand when the first-use path changed.** Connect one coding agent in **Settings > Coding agents**, send a first request in `/persistent`, and confirm that it reaches review and completes. This is required the first time, when `beta` does not exist yet. After that, decide by running this in each repository with the previous `beta` SHA; a person checks only when it prints something:
   ```bash
   # Soulstream
   git -C "$SOULSTREAM_DIR" diff --name-only "$PREVIOUS_BETA..$SOULSTREAM_SHA" -- \
     install/ \
     orch-server-ts/src/session/persistent_session_bootstrap.ts \
     orch-server-ts/src/session/persistent_session_settings_service.ts \
     orch-server-ts/src/session/persistent_session_settings_routes.ts \
     orch-server-ts/src/node/agent_login_routes.ts \
     orch-server-ts/src/node/claude_account_pool_routes.ts \
     orch-server-ts/src/node/node_claude_auth_routes.ts \
     orch-server-ts/src/node/node_claude_auth_helpers.ts \
     soul-server-ts/src/agent_login/ \
     soul-server-ts/src/claude_accounts/ \
     unified-dashboard/client/components/CodingAgentsTab.tsx \
     unified-dashboard/client/components/claude-accounts/ \
     unified-dashboard/client/lib/agent-login-api.ts \
     unified-dashboard/client/v3/PersistentSessionEmptyState.tsx

   # atom
   git -C "$ATOM_DIR" diff --name-only "$PREVIOUS_BETA..$ATOM_SHA" -- \
     src/mcp/ \
     src/api/middleware/auth.ts \
     src/api/agent-key-auth.ts \
     src/api/auth-mode.ts \
     src/api/routes/auth.ts \
     src/api/routes/auth_callback_handlers.ts \
     src/api/routes/auth_helpers.ts \
     src/api/routes/mcp.ts
   ```
   `install/` includes the starter seed and the installer. Use each repository's own previous `beta` SHA as `PREVIOUS_BETA`.
5. **Move `beta` with one script.** Fill in the values and run the script. It fetches both repositories and makes every assertion first, and pushes only after all of them pass. It never forces a push.
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   SOULSTREAM_DIR=/path/to/soulstream
   ATOM_DIR=/path/to/atom
   SOULSTREAM_SHA=<40-character SHA>
   ATOM_SHA=<40-character SHA>
   FRESH_RECORD=/path/to/fresh-install-state.json
   UPDATE_RECORD=/path/to/update-install-state.json   # leave empty only when beta does not exist yet

   has_beta() { git -C "$1" rev-parse --verify --quiet refs/remotes/origin/beta >/dev/null; }
   check() { # name dir sha
     local name=$1 dir=$2 sha=$3
     git -C "$dir" merge-base --is-ancestor "$sha" origin/main
     jq -e --arg n "$name" --arg sha "$sha" '.status == "completed" and .repositories[$n].current_sha == $sha' "$FRESH_RECORD" >/dev/null
     if has_beta "$dir"; then
       git -C "$dir" merge-base --is-ancestor origin/beta "$sha"
       jq -e --arg n "$name" --arg sha "$sha" --arg old "$(git -C "$dir" rev-parse origin/beta)" \
         '.status == "completed" and .repositories[$n].current_sha == $sha and .repositories[$n].previous_sha == $old' "$UPDATE_RECORD" >/dev/null
     fi
   }

   git -C "$ATOM_DIR" fetch --prune origin
   git -C "$SOULSTREAM_DIR" fetch --prune origin
   check atom "$ATOM_DIR" "$ATOM_SHA"
   check soulstream "$SOULSTREAM_DIR" "$SOULSTREAM_SHA"

   git -C "$ATOM_DIR" push origin "$ATOM_SHA:refs/heads/beta" && git -C "$SOULSTREAM_DIR" push origin "$SOULSTREAM_SHA:refs/heads/beta"
   ```
   The assertions are: each candidate is an ancestor of `origin/main`; an existing `origin/beta` is an ancestor of the candidate and equals the previous `beta` used in step 3; and the record files show the candidate as `current_sha`. The VMs are already deleted at this point, so the script reads the records, not a server. If the second push fails, run the same script again. The first push is then a no-op and the second one completes the move. Do not use `--force` or a `+` refspec.
6. **Fix forward.** `beta` never moves backward, and the repository rules block deleting it or rewriting it. To fix a bad `beta`, put the fix on `main`, run steps 1 to 5 again, and move `beta` forward to the fixed commit.
7. **Delete each VM as soon as its check ends.** Delete the instance; do not just shut it down.
