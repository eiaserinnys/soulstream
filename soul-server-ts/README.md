# @soulstream/soul-server-ts

Soulstream's TypeScript execution worker. It connects to the orchestrator over
the authenticated node WebSocket, runs configured Claude, Codex, and OpenAI
Agents backends, and sends session events back to the orchestrator.

Durable session state and PostgreSQL access are hosted by the orchestrator. The
worker does not open a PostgreSQL connection during normal runtime.

## Responsibilities

- Register the worker, its agent profiles, and model availability with the
  orchestrator.
- Receive session, intervention, response, interrupt, and approval commands
  over the node WebSocket.
- Run agent backends and manage their worker-local lifecycle.
- Send events and session mutations through the orchestrator-hosted persistence
  boundary.
- Keep a node-local semantic event retry outbox in `EVENT_OUTBOX_DIR`.
- Expose `GET /health` and configured worker-local HTTP surfaces such as MCP,
  LLM proxy, Cogito search, task or board mutations, and context preview.

The worker does not expose the public bot HTTP API, own the shared database, or
apply shared cluster migrations. Bot clients call the orchestrator API described
in [`docs/bot-client-api.md`](../docs/bot-client-api.md).

## Configuration

The process loads `.env.soul-server-ts` from its working directory. Start from
the repository example:

```bash
cp .env.soul-server-ts.example .env.soul-server-ts
```

### Required settings

| Key | Description |
|---|---|
| `SOULSTREAM_NODE_ID` | Unique worker ID advertised to the orchestrator. |
| `SOULSTREAM_UPSTREAM_URL` | Orchestrator node WebSocket URL using `ws://` or `wss://`. |
| `EVENT_OUTBOX_DIR` | Node-local durable event retry directory. There is no code fallback. |

### Conditional settings

| Key | Required when | Description |
|---|---|---|
| `AUTH_BEARER_TOKEN` | `ENVIRONMENT=production` | Authenticates the node connection and protected orchestrator calls. |
| `CLAUDE_AUTH_TOKEN_PATH` | The agent registry contains a Claude backend | Explicit worker-local Claude auth storage. The worker does not implicitly share another runtime's auth files. |
| `MCP_REQUIRE_AUTH=true` | MCP is enabled in production | Protects the worker's Streamable HTTP MCP endpoint. |

### Common optional settings

| Key | Default | Description |
|---|---|---|
| `HOST` | `127.0.0.1` | Worker HTTP bind address. |
| `PORT` | `4205` | Worker HTTP port. |
| `ENVIRONMENT` | `development` | Runtime environment. |
| `LOG_LEVEL` | `info` | Pino log level. |
| `AGENTS_CONFIG_PATH` | `config/agents.yaml` | Agent registry YAML path, resolved from the working directory. |
| `AGENT_PROFILE_CACHE_PATH` | `.local/cache/agent-profiles.json` | Last-known-good orchestrator profile overlay. |
| `MODEL_CATALOG_PATH` | `config/model-catalog.yaml` | Node-local model preset catalog. A missing file means an empty catalog. |
| `INCOMING_FILE_DIR` | `.local/incoming` | Files delivered by the orchestrator for agent turns. |
| `MCP_ENABLED` | `false` | Enables the worker MCP endpoint. |
| `MCP_PATH` | `/mcp` | Streamable HTTP MCP route. |
| `MCP_REQUIRE_AUTH` | `false` | Requires bearer authentication for MCP requests. |
| `MCP_ALLOWED_HOSTS` | `localhost,127.0.0.1` | Comma-separated Host header allowlist. |
| `CLAUDE_SESSION_RUNTIME_V2_ENABLED` | `true` | Persistent Claude Query runtime. Set `false` only as the emergency legacy kill switch. |
| `CLAUDE_SESSION_RUNTIME_IDLE_TTL_MS` | `300000` | Idle Query reclamation delay. |
| `CLAUDE_SESSION_RUNTIME_MAX_ENTRIES` | `16` | Worker-local persistent Query cap. |
| `CLAUDE_SESSION_RUNTIME_TURN_TIMEOUT_MS` | `1800000` | Foreground Claude turn timeout. |

`DATABASE_URL` is intentionally absent from the worker `EnvSchema`. In a
cluster, the central orchestrator deployment owns PostgreSQL credentials and
migrations. The standalone installer may place `DATABASE_URL` in the generated
deployment environment because its release executor initializes and migrates the
database; the worker runtime still ignores that key.

## Local start

Run these commands from the repository root:

```bash
corepack enable
pnpm install --frozen-lockfile

cp soul-server-ts/config/agents.yaml.example soul-server-ts/config/agents.yaml
cp soul-server-ts/config/model-catalog.yaml.example soul-server-ts/config/model-catalog.yaml
cp .env.soul-server-ts.example .env.soul-server-ts
```

Point the worker configuration at the copied files:

```dotenv
SOULSTREAM_NODE_ID=local-worker
SOULSTREAM_UPSTREAM_URL=ws://127.0.0.1:5200/ws/node
EVENT_OUTBOX_DIR=.local/event-outbox
AGENTS_CONFIG_PATH=soul-server-ts/config/agents.yaml
MODEL_CATALOG_PATH=soul-server-ts/config/model-catalog.yaml
ENVIRONMENT=development
```

Build and start the worker after the orchestrator is listening:

```bash
pnpm --dir soul-server-ts build
pnpm --dir soul-server-ts start
```

The default health URL is `http://127.0.0.1:4205/health`. If MCP is enabled,
its default URL is `http://127.0.0.1:4205/mcp`.

## Persistence and releases

Normal worker reads and writes cross the orchestrator persistence-host boundary.
The worker's local outbox only buffers semantic events until the orchestrator
acknowledges durable persistence.

- [`deploy/release-manifest.json`](../deploy/release-manifest.json) assigns
  shared database migration authority to the central orchestrator deployment.
- [`deploy/release-manifest-worker.json`](../deploy/release-manifest-worker.json)
  contains no migration apply phase and is the cluster worker manifest.
- [`deploy/release-manifest-standalone.json`](../deploy/release-manifest-standalone.json)
  gives a standalone release executor migration authority for later releases.
- [`scripts/verify-migrations.mjs`](scripts/verify-migrations.mjs) is a
  compatibility verifier. It explicitly skips on credential-free workers; it
  does not transfer migration authority away from the central deployment.

The worker-only Haniel reference is
[`install/haniel-soul-server-ts.example.yaml`](../install/haniel-soul-server-ts.example.yaml).
The Windows standalone installer uses
[`install/haniel-standalone.yaml.template`](../install/haniel-standalone.yaml.template)
and initializes a fresh database before starting the worker.

## Development

```bash
pnpm --dir soul-server-ts typecheck
pnpm --dir soul-server-ts test
pnpm --dir soul-server-ts dev
```

## Contract references

- Worker environment schema: [`src/config.ts`](src/config.ts)
- Worker composition: [`src/runtime/worker_composition.ts`](src/runtime/worker_composition.ts)
- Node-to-orchestrator wire schema: [`packages/wire-schema/generated/typescript/index.ts`](../packages/wire-schema/generated/typescript/index.ts)
- PostgreSQL schema and migrations: [`packages/db-schema`](../packages/db-schema)
