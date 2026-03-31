# Soulstream

Soulstream is a server that hosts Claude Code sessions remotely. It manages session lifecycle, SSE streaming, credential management, and runner pool warm-up — exposing Claude Code as a service that Slack bots and other clients can connect to over HTTP/SSE.

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

## Architecture: dual storage mode

### File mode (default)

```
SERENDIPITY_ENABLED=false
```

Session data is stored on the local filesystem. No external dependencies.

### Serendipity mode

```
SERENDIPITY_ENABLED=true
SERENDIPITY_URL=http://localhost:4002
```

Session data is stored in [Serendipity](https://github.com/eiaserinnys/serendipity) using a block-based hierarchy. Metadata (title, category labels, date tags) is generated automatically.

| SSE event | Block type | Description |
|-----------|------------|-------------|
| prompt (first) | `soul:user` | User prompt |
| `text_delta` | `soul:response` | Claude response text |
| `tool_start` | `soul:tool-call` | Tool call start |
| `tool_result` | `soul:tool-result` | Tool execution result |
| `intervention_sent` | `soul:intervention` | User intervention |
| `error` | `soul:system` | System error |

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
| `SERENDIPITY_ENABLED` | `true` | Enable Serendipity storage mode |
| `SERENDIPITY_URL` | `http://localhost:4002` | Serendipity API URL |
| `DATABASE_URL` | *(none)* | PostgreSQL URL (SQLite used if unset) |
| `MAX_CONCURRENT_SESSIONS` | `3` | Maximum parallel Claude Code sessions |

See `soul-server/.env.example` for the full list.

## Building a bot client

See **[docs/bot-client-api.md](docs/bot-client-api.md)** for the complete HTTP/SSE API reference for Slack bots, Discord bots, and other clients.
