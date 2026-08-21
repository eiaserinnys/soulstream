# Soulstream lab node

This directory runs one manually managed Soulstream stack on `eiaserinnys` without Haniel. It owns a dedicated PostgreSQL container, TypeScript orchestrator, and TypeScript worker. The runtime clone and every mutable path stay below `/home/eias/services/soulstream-lab`.

## Isolation contract

| Resource | Lab value |
|---|---|
| Runtime clone | `/home/eias/services/soulstream-lab/repo` |
| Orchestrator | `127.0.0.1:5300` |
| Worker | `127.0.0.1:3116` |
| PostgreSQL | `127.0.0.1:5437` |
| Docker container | `soulstream-lab-postgres` |
| Docker volume | `soulstream-lab-postgres-data` |
| Database and user | `soulstream_lab` |
| State | `/home/eias/services/soulstream-lab/state` |
| Logs | `/home/eias/services/soulstream-lab/logs` |
| Event outbox | `/home/eias/services/soulstream-lab/outbox` |
| Runner state | `/home/eias/services/soulstream-lab/runner-state` |
| Agent workspace | `/home/eias/services/soulstream-lab/workspace` |

The scripts refuse the production ports, refuse a container or volume lacking the `com.soulstream.lab=true` label, and never read an ambient `DATABASE_URL`. They do not call Haniel and do not operate any production container.

## First bootstrap

Clone `main` into the fixed runtime path. Do not point the service at a Git worktree.

```bash
git clone --branch main git@github.com:eiaserinnys/soulstream.git /home/eias/services/soulstream-lab/repo
```

Provide a readable Claude OAuth token file only for bootstrap. Bootstrap copies it to the lab state with mode `0600`; the worker receives only the isolated destination path. Generated PostgreSQL, bearer, and JWT secrets are written to `/home/eias/services/soulstream-lab/.env` with mode `0600` and are never printed.

```bash
LAB_CLAUDE_AUTH_SOURCE=/absolute/path/to/claude-auth.json \
  /home/eias/services/soulstream-lab/repo/scripts/lab-node/bootstrap.sh
```

Bootstrap creates the dedicated Docker resources, initializes the empty database through the canonical migration ledger, verifies migrations, installs dependencies, and builds the worker and orchestrator sequentially under the host verification lock.

Each Git commit receives its own database release journal below `state/database-release/lab-{sha}`. Re-running bootstrap after a fast-forward therefore reconciles the already-current lab schema without colliding with a previous release identity.

The migration command is `migrate.mjs initialize`, not `apply`: the canonical migration implementation explicitly rejects normal `apply` for an empty database and routes `initialize` to a fresh install without manual ledger edits.

## Start, status, and stop

```bash
/home/eias/services/soulstream-lab/repo/scripts/lab-node/start.sh
/home/eias/services/soulstream-lab/repo/scripts/lab-node/status.sh
/home/eias/services/soulstream-lab/repo/scripts/lab-node/stop.sh
```

`start.sh` is idempotent. It starts the owned PostgreSQL container, verifies the schema initialized by `bootstrap.sh`, then starts orch and worker and waits until `GET /api/nodes` contains exactly one `eias-lab` entry.

`stop.sh` sends SIGTERM only to PIDs whose command lines match this runtime clone. It then stops only the labeled lab PostgreSQL container. It never sends SIGKILL.

## Node restart and SDK smoke

The stage-1 proof creates one Claude session, waits for an exact assistant marker, sends SIGTERM to the worker host, restarts it, and delivers a second message to the same session through `/intervene`.

```bash
/home/eias/services/soulstream-lab/repo/scripts/lab-node/smoke.sh
```

The last smoke session ID is stored at `/home/eias/services/soulstream-lab/state/last-smoke-session`. Runtime API responses used by the proof remain below `state/smoke/` and contain no credentials.

To restart only the worker without running the smoke flow:

```bash
/home/eias/services/soulstream-lab/repo/scripts/lab-node/restart-node.sh
```

Keep at most two concurrent lab sessions. Before builds or smoke runs, confirm at least 2GB available memory with `free -m`.

## Updating the runtime clone

Stop the lab stack, fast-forward `main`, and rerun bootstrap so the worker release manifest is rebuilt against the lab deployment env.

```bash
/home/eias/services/soulstream-lab/repo/scripts/lab-node/stop.sh
git -C /home/eias/services/soulstream-lab/repo pull --ff-only origin main
LAB_CLAUDE_AUTH_SOURCE=/home/eias/services/soulstream-lab/state/claude-auth.json \
  /home/eias/services/soulstream-lab/repo/scripts/lab-node/bootstrap.sh
/home/eias/services/soulstream-lab/repo/scripts/lab-node/start.sh
```

Do not register this stack with Haniel during stage 1.
