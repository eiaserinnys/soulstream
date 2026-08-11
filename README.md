# Soulstream

![Soulstream dashboard](assets/soulstream-dashboard.png)

**Soulstream is a self-hosted control plane for running coding agents as an ongoing service.** It combines a live operations dashboard, durable sessions and workspaces, multi-node execution, and agent-facing MCP tools in one system.

Instead of treating an agent as a terminal process that disappears after one prompt, Soulstream gives it a durable place to work: sessions stream in real time, tasks and pages carry context between turns, workers can run on different machines, and the control plane keeps the history in PostgreSQL.

## What Soulstream provides

- **Long-lived agent sessions** with streaming output, follow-up messages, interruption, review, attachments, and resumable history.
- **Multiple execution backends** through worker profiles: Claude, Codex, and OpenAI Agents.
- **A unified dashboard** for daily work, projects, tasks, pages, boards, connected nodes, and live or completed sessions.
- **Multi-node execution** with a TypeScript orchestrator routing authenticated WebSocket commands to TypeScript workers.
- **Durable context** assembled from the active task, page, folder, prior turns, attachments, and configured knowledge sources.
- **MCP access** for agents to inspect the service, browse work, search session history, manage tasks and pages, and coordinate sessions without leaving their runtime.
- **Release-safe operations** through Haniel manifests that separate central database migration authority from worker-only updates.

## Architecture

![Soulstream architecture](assets/soulstream-architecture.png)

The production control plane is `orch-server-ts`. It serves the built dashboard, owns the public HTTP/SSE surface, keeps the connected-node registry, and persists canonical state in PostgreSQL. `soul-server-ts` workers execute agent turns and connect upstream over WebSocket; their local HTTP surface is limited to health, optional MCP, and node-local support routes.

The Python `orch-server` runtime and its supervisor subsystem are retired. Python code remains only where the repository still needs compatibility contracts, migration tooling, or shared legacy assets; it is not the live server architecture.

## Repository layout

```text
soulstream/
├── orch-server-ts/         Production TypeScript orchestrator and API
├── soul-server-ts/         TypeScript execution worker and MCP server
├── unified-dashboard/      React dashboard and PWA
├── packages/
│   ├── db-schema/          Canonical PostgreSQL schema and migrations
│   ├── fractional-position/ Shared ordering primitive
│   ├── page-model/         Shared page, block, and task-page contracts
│   ├── search-contract/    Shared search request and result contracts
│   ├── soul-ui/            Reusable dashboard UI and state modules
│   ├── wire-schema/        Canonical node ↔ orchestrator protocol
│   └── soul-common/        Legacy Python compatibility and contract support
├── chrome-extension/       Optional page-action client
├── soul-desktop/           Tauri desktop client
├── deploy/                 Haniel release and database safety manifests
├── install/                Windows and Haniel installation templates
└── orch-server/            Deprecated Python orchestrator contracts
```

The pnpm workspace is declared in `pnpm-workspace.yaml`. The node ↔ orchestrator protocol is defined once in `packages/wire-schema/src/upstream.schema.json`; generated TypeScript and Python clients must stay in sync with that schema.

## Quick start

### Windows installer

The installer bootstraps a TypeScript worker installation, installs or reuses Haniel, prepares the repository and dashboard bundle, initializes an empty PostgreSQL database safely, and registers the service.

Prerequisites are checked before installation: Python 3.11 or newer, Node.js 20 or newer, and PostgreSQL 16 or newer client tools (`pg_dump` and `pg_restore`) on `PATH`.

Interactive install:

```powershell
irm https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/install.ps1 | iex
```

Non-interactive install:

```powershell
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/install.ps1'))) `
  -NonInteractive `
  -DatabaseUrl $env:SOULSTREAM_DATABASE_URL `
  -AuthBearerToken $env:SOULSTREAM_AUTH_BEARER_TOKEN
```

The default install directory is `%USERPROFILE%\soulstream`, the default agent workspace is `%USERPROFILE%\workspace`, and the default worker port is `3105`. Non-interactive mode requires both the database URL and the shared orchestrator service token. A complete cluster also needs an `orch-server-ts` control plane reachable at the worker's configured `SOULSTREAM_UPSTREAM_URL`.

Haniel auto-apply is disabled by default. It detects new commits and presents them for approval without silently pulling or restarting the service.

### Run from source

For local development, use Node.js 20 or newer, pnpm 10, and PostgreSQL. Run commands from the repository root.

Install and build the active TypeScript surfaces:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --dir unified-dashboard build
pnpm --dir orch-server-ts build
pnpm --dir soul-server-ts build
```

Prepare a local agent registry and model catalog:

```bash
cp soul-server-ts/config/agents.yaml.example soul-server-ts/config/agents.yaml
cp soul-server-ts/config/model-catalog.yaml.example soul-server-ts/config/model-catalog.yaml
```

Create `.env.soul-server-ts` in the repository root for the worker:

```dotenv
SOULSTREAM_NODE_ID=local-worker
SOULSTREAM_UPSTREAM_URL=ws://127.0.0.1:5200/ws/node
EVENT_OUTBOX_DIR=.local/event-outbox
AGENTS_CONFIG_PATH=soul-server-ts/config/agents.yaml
MODEL_CATALOG_PATH=soul-server-ts/config/model-catalog.yaml
MCP_ENABLED=true
MCP_PATH=/mcp
MCP_INTERNAL_PORT=4206
MCP_STATELESS_TRANSPORT_ENABLED=false
ENVIRONMENT=development
```

Initialize a fresh, empty database once. The initializer also verifies an already-current database and fails closed when an upgrade requires the Haniel release path.

```bash
export DATABASE_URL=postgresql://user:password@127.0.0.1:5432/soulstream
node soul-server-ts/scripts/apply-schema.mjs
```

Start the orchestrator. `CLAUDE_OAUTH_CLIENT_ID` must contain a valid OAuth application client ID; the callback URL must be registered with that application.

```bash
export CLAUDE_OAUTH_CLIENT_ID=your-client-id
export CLAUDE_OAUTH_CALLBACK_URL=http://127.0.0.1:5200/api/nodes/claude-auth/callback

ENVIRONMENT=development \
HOST=127.0.0.1 \
PORT=5200 \
DATABASE_URL="$DATABASE_URL" \
DASHBOARD_DIR="$PWD/unified-dashboard/dist" \
CLAUDE_OAUTH_CLIENT_ID="$CLAUDE_OAUTH_CLIENT_ID" \
CLAUDE_OAUTH_CALLBACK_URL="$CLAUDE_OAUTH_CALLBACK_URL" \
pnpm --dir orch-server-ts start
```

In a second terminal, start the worker from the repository root so it loads `.env.soul-server-ts`:

```bash
node soul-server-ts/dist/main.js
```

The dashboard and orchestrator health endpoint are available at `http://127.0.0.1:5200/` and `http://127.0.0.1:5200/api/health`. The worker health endpoint defaults to `http://127.0.0.1:4205/health`, and its optional MCP endpoint defaults to `http://127.0.0.1:4205/mcp`.

## Configuration model

Agent profiles live in the YAML selected by `AGENTS_CONFIG_PATH`. Each profile declares an ID, display name, backend, workspace directory, and usually a `default_preset`. Model strings belong in the catalog selected by `MODEL_CATALOG_PATH`, so profile identity and model selection remain separate.

The worker's required runtime settings are:

- `SOULSTREAM_NODE_ID`: unique node identity advertised to the orchestrator.
- `SOULSTREAM_UPSTREAM_URL`: `ws://` or `wss://` orchestrator node endpoint.
- `EVENT_OUTBOX_DIR`: node-local durable event retry directory.

`AUTH_BEARER_TOKEN` is required for workers in production. If MCP is enabled in production, `MCP_REQUIRE_AUTH=true` is also required. `HOST` defaults to `127.0.0.1`, the worker `PORT` defaults to `4205`, and the orchestrator `PORT` defaults to `5200`.

The orchestrator requires `ENVIRONMENT`, `HOST`, `DATABASE_URL`, `CLAUDE_OAUTH_CLIENT_ID`, and `CLAUDE_OAUTH_CALLBACK_URL`. Production additionally requires an explicit CORS origin policy. Set `DASHBOARD_DIR` to the built `unified-dashboard/dist` directory to serve the UI from the orchestrator.

Keep credentials in environment files or the process manager's secret configuration. Do not commit service tokens, OAuth secrets, database credentials, or provider credentials.

## Development

Use package-local scripts so validation stays proportional to the surface you changed:

```bash
pnpm --dir orch-server-ts typecheck
pnpm --dir orch-server-ts test

pnpm --dir soul-server-ts typecheck
pnpm --dir soul-server-ts test

pnpm --dir unified-dashboard typecheck
pnpm --dir unified-dashboard test

pnpm --dir packages/soul-ui typecheck
pnpm --dir packages/soul-ui test
```

Useful contract and component references:

- [MCP server and tool reference](docs/mcp.md)
- [Node ↔ orchestrator wire contract](packages/wire-schema/src/README.md)
- [Database schema and release safety](packages/db-schema/README.md)
- [Task and page invariants](docs/task-page-invariants.md)
- [Chrome extension](chrome-extension/README.md)

## Deployment with Haniel

[Haniel](https://github.com/eiaserinnys/haniel) is Soulstream's process and release manager. The repository keeps deployment behavior explicit:

- `deploy/release-manifest.json` makes the central orchestrator deployment the shared database migration authority and defines preflight, backup, apply, post-start verification, and recovery.
- `deploy/release-manifest-worker.json` keeps worker-only deployments database-free and limits them to runtime verification and rollback.
- `deploy/release-manifest-standalone.json` owns the database lifecycle for a standalone installation.
- `install/haniel-soul-server-ts.example.yaml` is the worker-node integration reference.
- `install/haniel-standalone.yaml.template` is rendered by the Windows installer.

Normal service starts never apply schema changes. Database upgrades run through the release manifest so writer quiescence, backup requirements, migration checksums, health checks, and recovery remain one audited path.
