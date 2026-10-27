# Soulstream

![Soulstream dashboard](docs/screenshots/dashboard.png)

**Soulstream is a self-hosted control plane for running coding agents as an ongoing service.** It combines a live operations dashboard, durable work cards and sessions, multi-node execution, and agent-facing MCP tools in one system.

Instead of treating an agent as a terminal process that disappears after one prompt, Soulstream gives it a durable workspace. Sessions stream in real time, folders and cards carry context across turns, workers run across multiple machines, and the central control plane keeps canonical history in PostgreSQL.

## What Soulstream does

- **Long-lived agent sessions** with live streaming output, follow-up messages, mid-turn intervention, file attachments, and resumable history.
- **Structured work cards** inside hierarchical folders, tracking the request, check items with evidence, a one-line status (`now`), user questions, and review completion.
- **Persistent assistant sessions** with a live report board, active task lists, session monitoring, and weekly quota headroom.
- **Five execution backends** configured through node-local agent profiles and model presets: Claude, Codex, OpenAI Agents, Antigravity, and OpenCode.
- **Multi-node routing** where the TypeScript orchestrator (`orch-server-ts`) dispatches authenticated WebSocket commands to TypeScript workers (`soul-server-ts`).
- **Built-in MCP tools** for service reflection, session search, git worktrees, on-demand skill loading (`load_skill`), recurring jobs, and card or folder management.
- **Release-safe operations** with [Haniel](https://github.com/eiaserinnys/haniel) manifests that keep PostgreSQL migration authority on the central orchestrator while remote workers stay database-free.

## Interface previews

![Card detail in review with check items, recorded results, and the linked review session](docs/screenshots/card-detail.png)

<p>
  <img src="docs/screenshots/persistent-session.png" alt="Persistent assistant session with the report board and chat" width="74.5%">
  <img src="docs/screenshots/mobile.png" alt="The same persistent session on a phone-sized screen" width="21.5%">
</p>

The screenshots use demo data served by a Playwright fixture. Regenerate them with `pnpm --dir unified-dashboard capture:readme`.

## Quick start

### Windows worker installer

Register a `soul-server-ts` worker on Windows (requires Python 3.11+ and Node.js 22.5+) against an existing `orch-server-ts` control plane:

```powershell
irm https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/install.ps1 | iex
```

See [Installation](docs/guide/installation.md) for non-interactive parameters and Haniel service defaults.

### Run from source

Running the full stack locally requires Node.js 22.5 or newer, pnpm 10.32.1, and PostgreSQL:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --dir unified-dashboard build
pnpm --dir orch-server-ts build
pnpm --dir soul-server-ts build

cp soul-server-ts/config/agents.yaml.example soul-server-ts/config/agents.yaml
cp soul-server-ts/config/model-catalog.yaml.example soul-server-ts/config/model-catalog.yaml

export DATABASE_URL=postgresql://user:password@127.0.0.1:5432/soulstream
node packages/db-schema/scripts/migrate.mjs fresh-install
```

See [Installation](docs/guide/installation.md) and [Configuration](docs/guide/configuration.md) for the `.env.soul-server-ts` worker file and orchestrator startup commands.

## Documentation

- [Concepts](docs/guide/concepts.md): folders, cards, sessions, persistent assistant sessions, agents, model presets, and nodes.
- [Architecture](docs/guide/architecture.md): system diagram, control plane and worker roles, multi-node routing, backends, and repository layout.
- [Installation](docs/guide/installation.md): prerequisites, Windows worker installer, source build, database initialization, and local dev servers.
- [Configuration](docs/guide/configuration.md): orchestrator and worker environment variables, `agents.yaml`, `model-catalog.yaml`, and secret handling.
- [Agents and tools](docs/guide/agents-and-tools.md): skill catalog (`load_skill`), MCP tool groups, worktrees, pages, recurring jobs, custom views, attachments, and usage stats.
- [Development](docs/guide/development.md): package typecheck and test scripts, Playwright suites, screenshot regeneration, and internal architecture references.
- [Deployment](docs/guide/deployment.md): Haniel release manifests, central database migration authority, and worker rollout.
