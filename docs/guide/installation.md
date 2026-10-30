# Installation

This guide covers installing a remote Windows worker with the PowerShell installer and running the full Soulstream stack from source.

## Requirements

- **Node.js**: 22.5 or newer (`>=22.5`).
- **pnpm**: `10.32.1` (managed via `corepack enable`).
- **PostgreSQL**: required by `orch-server-ts` for canonical persistence. Execution workers (`soul-server-ts`) do not connect to PostgreSQL.
- **Python**: 3.11 or newer (checked by the Windows worker installer).

## Windows worker installer

The PowerShell installer ([`install/install.ps1`](../../install/install.ps1)) registers a `soul-server-ts` worker on Windows with an existing remote `orch-server-ts` control plane. It does not install an orchestrator or run database migrations.

Before installing, the script verifies Python 3.11+ and Node.js 22.5+, installs the Claude Code CLI, [Haniel](https://github.com/eiaserinnys/haniel), and pnpm `10.32.1` if missing, generates `haniel.yaml` and `.env.soul-server-ts`, builds `soul-server-ts`, and starts the worker service.

Interactive install:

```powershell
irm https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/install.ps1 | iex
```

Non-interactive install:

```powershell
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/install.ps1'))) `
  -NonInteractive `
  -UpstreamUrl $env:SOULSTREAM_UPSTREAM_URL `
  -AuthBearerToken $env:SOULSTREAM_AUTH_BEARER_TOKEN
```

Installer defaults and flags:

- Default install directory (`-InstallDir`): `%USERPROFILE%\soulstream`
- Default agent workspace (`-WorkspaceDir`): `%USERPROFILE%\workspace`
- Default worker port (`-Port`): `3105`
- Required in `-NonInteractive` mode: `-UpstreamUrl` (remote orchestrator WebSocket URL) and `-AuthBearerToken` (shared service token).
- Haniel auto-apply is disabled by default. It detects new commits and presents them for approval without silently pulling or restarting the service.

## Running from source

Run all workspace commands from the repository root.

1. Enable Corepack, install dependencies, and build the active TypeScript packages:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --dir unified-dashboard build
pnpm --dir orch-server-ts build
pnpm --dir soul-server-ts build
```

2. Copy the example agent registry and model catalog for the local worker:

```bash
cp soul-server-ts/config/agents.yaml.example soul-server-ts/config/agents.yaml
cp soul-server-ts/config/model-catalog.yaml.example soul-server-ts/config/model-catalog.yaml
```

3. Create `.env.soul-server-ts` in the repository root for the worker:

```dotenv
SOULSTREAM_NODE_ID=local-worker
SOULSTREAM_UPSTREAM_URL=ws://127.0.0.1:5200/ws/node
EVENT_OUTBOX_DIR=.local/event-outbox
AGENTS_CONFIG_PATH=soul-server-ts/config/agents.yaml
MODEL_CATALOG_PATH=soul-server-ts/config/model-catalog.yaml
MCP_ENABLED=true
MCP_PATH=/mcp
MCP_INTERNAL_PORT=4206
ENVIRONMENT=development
```

## Fresh database initialization

Initialize a fresh, empty PostgreSQL database once before starting `orch-server-ts`. The `fresh-install` command also verifies an already-current database and fails closed when an existing database requires pending migrations through the Haniel release path:

```bash
export DATABASE_URL=postgresql://user:password@127.0.0.1:5432/soulstream
node packages/db-schema/scripts/migrate.mjs fresh-install
```

Start the orchestrator (`CLAUDE_OAUTH_CLIENT_ID` must contain a valid OAuth application client ID, and `CLAUDE_OAUTH_CALLBACK_URL` must be registered with that application):

```bash
export CLAUDE_OAUTH_CLIENT_ID=your-client-id
export CLAUDE_OAUTH_CALLBACK_URL=http://127.0.0.1:5200/api/nodes/claude-auth/callback

ENVIRONMENT=development \
HOST=127.0.0.1 \
PORT=5200 \
DATABASE_URL="$DATABASE_URL" \
SOULSTREAM_PUBLIC_URL="http://127.0.0.1:5200" \
DASHBOARD_DIR="$PWD/unified-dashboard/dist" \
CLAUDE_OAUTH_CLIENT_ID="$CLAUDE_OAUTH_CLIENT_ID" \
CLAUDE_OAUTH_CALLBACK_URL="$CLAUDE_OAUTH_CALLBACK_URL" \
pnpm --dir orch-server-ts start
```

In a second terminal, start the worker from the repository root so it loads `.env.soul-server-ts`:

```bash
node soul-server-ts/dist/main.js
```

For unbundled worker development, you can also run:

```bash
pnpm --dir soul-server-ts dev
```

Default local endpoints:

- Web dashboard: `http://127.0.0.1:5200/`
- Orchestrator health check: `http://127.0.0.1:5200/api/health`
- Worker health check: `http://127.0.0.1:4205/health`
- Node-local internal MCP endpoint: `http://127.0.0.1:4206/mcp/internal` (bound to `127.0.0.1`; the public worker listener has no MCP route)

## Dashboard dev server

To run the Vite development server for `unified-dashboard` with hot module replacement, point it at a running orchestrator with `VITE_API_BASE` (the dev server refuses to start without it):

```bash
VITE_API_BASE=http://localhost:5200 pnpm --dir unified-dashboard dev
```

## Mobile app dev start

`soul-app` is a standalone Expo package outside the pnpm workspace. Install its dependencies and start the Expo development server with `npm --prefix soul-app`:

```bash
npm --prefix soul-app ci
npm --prefix soul-app start
```

Platform-specific Expo scripts in [`soul-app/package.json`](../../soul-app/package.json):

```bash
npm --prefix soul-app run ios
npm --prefix soul-app run android
npm --prefix soul-app run web
```
