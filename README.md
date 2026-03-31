# Soulstream

![Soulstream](assets/soulstream.jpg)

**Run Claude Code as a service.** Point your Slack bot, Discord bot, or any HTTP client
at Soulstream and it handles the rest — session lifecycle, SSE streaming, multi-turn
conversations, credential rotation, and a built-in dashboard.

No Claude SDK in your bot. No process management. Just HTTP.

## Multi-agent

Define multiple agents, each with its own workspace and `CLAUDE.md` instructions.
Route requests to a specific agent by name — your Slack bot talks to one agent,
your Discord bot to another, each operating in a fully isolated environment.

```json
// POST /sessions  →  { "agent_id": "my-agent", "prompt": "..." }
```

Agent definitions live in the server config. Each agent gets:
- Its own `workspace_dir` (Claude Code's working directory)
- Its own `CLAUDE.md` (instructions, tools, persona)
- Its own credential profile (independent Claude account / API key)

## Repository layout

```
soulstream/
├── soul-server/          # FastAPI execution server (Python)
├── unified-dashboard/    # React dashboard (TypeScript)
├── packages/
│   └── soul-ui/          # Shared UI component library
└── install/              # Standalone installer
    ├── install.ps1                       # One-liner Windows installer
    └── haniel-standalone.yaml.template   # Haniel config template
```

## Quick start

### Standalone installer (Windows)

```powershell
irm https://raw.githubusercontent.com/eiaserinnys/soulstream/main/install/install.ps1 | iex
```

The installer checks prerequisites, installs [Haniel](https://github.com/eiaserinnys/haniel) as the process manager, clones this repo, sets up a Python venv, prompts for configuration, builds the dashboard, and registers a Windows service — all in one pass.

### Manual setup

**soul-server**

```bash
cd soul-server
python -m venv .venv
source .venv/bin/activate   # Linux/macOS
# .venv\Scripts\activate    # Windows
pip install -e ../packages/soul-common -e .
python -m soul_server.main
```

**unified-dashboard**

```bash
cd unified-dashboard
pnpm install
pnpm run dev
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKSPACE_DIR` | *(required)* | Claude Code working directory |
| `SOULSTREAM_NODE_ID` | *(required)* | Unique node identifier |
| `SOUL_DASHBOARD_CACHE_DIR` | *(required)* | Dashboard session cache directory |
| `PORT` | `3105` | Server port |
| `HOST` | `0.0.0.0` | Server host |
| `ENVIRONMENT` | `development` | `development` or `production` |
| `AUTH_BEARER_TOKEN` | *(none)* | API bearer token (leave empty to disable auth) |
| `SOUL_DASHBOARD_DIR` | `dist/client` | Path to built dashboard files |
| `DATABASE_URL` | *(none)* | PostgreSQL URL (SQLite used if unset) |
| `MAX_CONCURRENT_SESSIONS` | `3` | Maximum parallel Claude Code sessions |

See `soul-server/.env.example` for the full list.

## Building a bot client

See **[docs/bot-client-api.md](docs/bot-client-api.md)** for the complete HTTP/SSE API reference for Slack bots, Discord bots, and other clients.

## MCP server

Soulstream ships with a built-in MCP server. Claude Code sessions can connect to it and use tools to inspect service capabilities, search past session history, manage folders, and more — without leaving the session.

See **[docs/mcp.md](docs/mcp.md)** for the full tool reference and connection instructions.

## Authentication setup

See **[docs/google-auth.md](docs/google-auth.md)** for configuring Google OAuth (dashboard login) and connecting a Claude.ai account for running sessions.
