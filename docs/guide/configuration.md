# Configuration

Soulstream splits configuration between the central orchestrator (`orch-server-ts`) and node-local workers (`soul-server-ts`). Reference templates live in [`orch-server-ts/.env.example`](../../orch-server-ts/.env.example), [`.env.soul-server-ts.example`](../../.env.soul-server-ts.example), [`soul-server-ts/config/agents.yaml.example`](../../soul-server-ts/config/agents.yaml.example), and [`soul-server-ts/config/model-catalog.yaml.example`](../../soul-server-ts/config/model-catalog.yaml.example).

## Orchestrator environment variables

Defined in [`orch-server-ts/.env.example`](../../orch-server-ts/.env.example):

### Core runtime and database

- `ENVIRONMENT`: required runtime mode (`development`, `test`, or `production`).
- `HOST`: required HTTP listener bind address (defaults to `127.0.0.1` in local setups).
- `PORT`: HTTP listener port (defaults to `5200`).
- `DATABASE_URL`: required PostgreSQL connection URL.
- `DASHBOARD_DIR`: optional path to the built `unified-dashboard/dist` directory when serving the web UI from the orchestrator.
- `NODE_NAME`: optional human-readable node label (required when external MCP ingress is enabled).

Board and attachment Cloudflare R2 storage settings are managed in the central PostgreSQL database admin settings rather than environment variables.

### Authentication and CORS

- `AUTH_BEARER_TOKEN`: shared service bearer token. Required in `production`; may be left empty in `development`.
- `CORS_ALLOWED_ORIGINS`: explicit allowed CORS origins. Required in `production`.
- `CLAUDE_OAUTH_CLIENT_ID`: required OAuth client ID for browser-initiated Claude node authentication.
- `CLAUDE_OAUTH_CALLBACK_URL`: required OAuth callback URL registered with the Claude OAuth application.
- `GOOGLE_CLIENT_ID`: optional Google OAuth client ID for dashboard login.
- `GOOGLE_CLIENT_SECRET`: optional Google OAuth client secret.
- `GOOGLE_CALLBACK_URL`: optional Google OAuth callback URL.
- `GOOGLE_IOS_CLIENT_ID`: optional Google OAuth client ID for the iOS app.
- `ALLOWED_EMAIL`: optional email allowlist for Google authentication.
- `JWT_SECRET`: optional signing secret for dashboard authentication tokens.

### Knowledge, search, usage, and runner controls

- `ATOM_ENABLED`: enables optional Atom knowledge tree integration.
- `ATOM_SERVER_URL`: base URL of the Atom server.
- `ATOM_API_KEY`: API key for Atom requests.
- `ATOM_ROOT_NODE_ID`: root node ID for Atom tree lookups.
- `SKILL_CATALOG_NODE_ID`: Atom node ID for the shared skill catalog.
- `DOMAIN_CATALOG_NODE_ID`: Atom node ID for domain catalogs used by `load_skill`.
- `TYPESAFE_API_KEY`: optional API key for Jev reranking in expanded session search (when absent, expanded search returns partial RRF results; see [`orch-server-ts/docs/session-search-deployment.md`](../../orch-server-ts/docs/session-search-deployment.md)).
- `CODEX_CLI_PATH`: optional path override for the Codex CLI binary on ephemeral routes.
- `AGY_CLI_PATH`: optional path override for the Antigravity (`agy`) CLI binary.
- `MODEL_CATALOG_PATH`: optional path to a model catalog YAML file.
- `TURN_SUMMARY_OPENAI_KEY`: optional OpenAI API key for generating turn summaries.
- `USAGE_SUMMARY_POLL_INTERVAL_SECONDS`: polling interval in seconds for provider usage summaries (defaults to `300`).
- `USAGE_SUMMARY_SHARED_ACCOUNTS`: optional shared account grouping configuration for provider usage aggregation.
- `SOUL_RUNNER_PROCESS_ENABLED`: enables isolated runner child processes.
- `SOUL_RUNNER_LEASE_TIMEOUT_MS`: lease timeout in milliseconds for runner processes.

### Orchestrator external MCP ingress

- `MCP_EXTERNAL_INGRESS_ENABLED`: enables the dedicated credential-bound external MCP ingress route (disabled by default; requires `NODE_NAME`).
- `MCP_EXTERNAL_INGRESS_PATH`: HTTP path for external MCP ingress.
- `MCP_EXTERNAL_INGRESS_SOURCE`: caller source identifier attached to external ingress requests.
- `MCP_EXTERNAL_INGRESS_DISPLAY_NAME`: display name for the external ingress caller.
- `MCP_EXTERNAL_INGRESS_BEARER_TOKEN`: bearer token required by the external MCP connector.
- `MCP_EXTERNAL_EVENTS_STATE_FILE`: file path for persisting external MCP subscription state.
- `MCP_ALLOWED_HOSTS`: host allowlist for the dedicated external MCP connector.

## Worker environment variables

Defined in [`.env.soul-server-ts.example`](../../.env.soul-server-ts.example):

### Required identity and outbox

- `SOULSTREAM_NODE_ID`: unique node identifier advertised to `orch-server-ts`.
- `SOULSTREAM_UPSTREAM_URL`: `ws://` or `wss://` URL of the orchestrator's `/ws/node` endpoint.
- `EVENT_OUTBOX_DIR`: node-local directory for durable event buffering and retry.

### Local HTTP listener and auth

- `HOST`: local HTTP bind address (defaults to `127.0.0.1`).
- `PORT`: local HTTP port for health and node-local routes (defaults to `4205`).
- `ENVIRONMENT`: runtime environment (`development`, `test`, or `production`).
- `LOG_LEVEL`: logger verbosity (for example, `info`).
- `AUTH_BEARER_TOKEN`: shared service bearer token (required when `ENVIRONMENT=production`).

### Loopback MCP and git worktrees

- `MCP_ENABLED`: enables the worker's built-in MCP server (`true` or `false`).
- `MCP_PATH`: base MCP path prefix (defaults to `/mcp`; internal route mounts at `${MCP_PATH}/internal`).
- `MCP_INTERNAL_PORT`: loopback TCP port (`127.0.0.1`) for the stateless internal MCP listener (defaults to `PORT+1`, must differ from `PORT`).
- `MCP_REQUIRE_AUTH`: requires bearer authentication on MCP requests (required when MCP is enabled in `production`).
- `WORKTREE_MCP_ENABLED`: explicit node-local rollout gate for git worktree MCP tools (`false` by default).
- `WORKTREE_CREATE_TIMEOUT_MS`: timeout in milliseconds for creating a git worktree (defaults to `120000`; can be raised to `1800000` on slow disks).
- `WORKTREE_PROJECTS_ROOT`: absolute path to the shared repositories directory (required when `WORKTREE_MCP_ENABLED=true`).

### Agent registry, model catalog, and runtime

- `AGENTS_CONFIG_PATH`: path to the node's `agents.yaml` file.
- `AGENT_PROFILE_CACHE_PATH`: local cache file path for agent profiles.
- `MODEL_CATALOG_PATH`: path to the node's `model-catalog.yaml` file.
- `CLAUDE_AUTH_TOKEN_PATH`: optional path to the node's Claude OAuth credentials JSON file (managed via the dashboard or mobile app Claude OAuth flow).
- `AGY_CLI_PATH`: optional path to the Antigravity (`agy`) CLI executable.
- `OPENCODE_CLI_PATH`: optional path to the OpenCode (`opencode`) CLI executable.
- `INCOMING_FILE_DIR`: local directory for staging incoming session attachments.
- `CLAUDE_SESSION_RUNTIME_V2_ENABLED`: enables the persistent Claude session runtime (`true` by default; `false` acts as an emergency kill switch).
- `CLAUDE_SESSION_RUNTIME_IDLE_TTL_MS`: idle time-to-live in milliseconds for cached Claude runtime entries (defaults to `300000`).
- `CLAUDE_SESSION_RUNTIME_MAX_ENTRIES`: maximum concurrent entries in the Claude session runtime pool (defaults to `16`).
- `CLAUDE_SESSION_RUNTIME_TURN_TIMEOUT_MS`: maximum inactivity gap in milliseconds during a turn (defaults to `1200000`).
- `DASH_USER_NAME`: optional user display name advertised to the orchestrator.
- `DASH_USER_PORTRAIT`: optional user portrait URL or path advertised to the orchestrator.

## Agent registry (`agents.yaml`)

Selected by `AGENTS_CONFIG_PATH` (see [`soul-server-ts/config/agents.yaml.example`](../../soul-server-ts/config/agents.yaml.example)). Each entry in `agents` defines an agent profile on the node:

```yaml
agents:
  - id: codex-default
    name: Codex Default
    backend: codex
    workspace_dir: /tmp/codex-default
    # model: gpt-5.5
    # max_turns: 50
    # allowed_tools:
    #   - bash
    #   - read
    # portrait_path: /var/lib/soulstream/portraits/codex-default.png
    # context_scope: minimal
```

- Required fields: `id`, `name`, `backend`, `workspace_dir`.
- Optional fields: `model`, `default_preset`, `max_turns`, `allowed_tools`, `disallowed_tools`, `portrait_path`, `context_scope` (`full` by default; `minimal` omits folder-inherited `page_context`, folder `atom_context`, `board_workspace`, `running_sessions`, and `cogito_context`), `claude_auto_memory_enabled` (Claude-only; `false` disables reading and writing `MEMORY.md`), `mcp_profile`, `atom_contexts`, and `env`.

## Model catalog (`model-catalog.yaml`)

Selected by `MODEL_CATALOG_PATH` (see [`soul-server-ts/config/model-catalog.yaml.example`](../../soul-server-ts/config/model-catalog.yaml.example)). Keeping model definitions in `model-catalog.yaml` decouples agent identity from specific vendor model strings.

```yaml
presets:
  - id: claude-sonnet
    label: Claude - Sonnet
    backend: claude
    model: sonnet
    supported_efforts: [low, medium, high, xhigh, max]
    default_effort: xhigh

  - id: codex-6.1-sol
    label: Codex - 6.1 Sol
    backend: codex
    model: gpt-6.1-sol
    supported_efforts: [low, medium, high, xhigh, max, ultra]
    default_effort: high

  - id: gemini-4-argon
    label: "Gemini - 4 Argon"
    backend: antigravity
    model: gemini-4-argon
    supported_efforts: [low, medium, high]
    default_effort: high
```

Catalog rules:

- Preset `id` values form a shared vocabulary across nodes even if the underlying `model` string differs by node.
- `supported_efforts` lists the reasoning effort levels advertised by the backend CLI or SDK; `default_effort` must be a member of `supported_efforts`. Omit both fields when a backend or endpoint does not support effort selection.
- Presets can define an `env` map (for example, `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY: "${KIMI_API_KEY}"`, and `CLAUDE_CODE_AUTO_COMPACT_WINDOW`). If a referenced environment variable is unset on the node, the preset remains visible in the UI with `available: false` and `reason: env_unresolved`.
- Presets can also define `mcp_tool_allowlist` per agent profile to restrict exposed MCP tools.
- `soul-server-ts` advertises its catalog when connecting to `/ws/node`. Restart `soul-server-ts` after adding or modifying presets in `model-catalog.yaml`.

## Secrets guidance

- Store service tokens (`AUTH_BEARER_TOKEN`, `MCP_EXTERNAL_INGRESS_BEARER_TOKEN`), OAuth credentials, `DATABASE_URL`, and provider API keys in untracked `.env` files or your process manager's secret store. Never commit secrets to git.
- Place `agents.yaml`, `model-catalog.yaml`, `mcp-profiles.yaml`, and `CLAUDE_AUTH_TOKEN_PATH` in a persistent shared directory outside the release checkout so code deployments do not overwrite node configuration or OAuth tokens.
- Never forward `MCP_INTERNAL_PORT` through nginx or any public reverse proxy; it must remain bound to `127.0.0.1` for node-local agent runners.
