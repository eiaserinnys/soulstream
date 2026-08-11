import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";

const LIVE_PORTS = new Set([3_105, 5_200, 4_205]);
const OWNED_ROOT = join(".local", "runner-staging-soak");
const SAFE_DATABASE_NAME = /^(?=.*(?:staging|soak))[a-z][a-z0-9_]{2,62}$/;

export interface SoakConfigFile {
  schemaVersion: 1;
  stagingRoot: string;
  host: "127.0.0.1" | "localhost";
  orchPort: number;
  soulPort: number;
  databaseName: string;
  databaseAdminUrlEnv: string;
  authBearerTokenEnv: string;
  claudeAuthTokenPathEnv: string;
  codexHomePathEnv: string;
  claudeOauthClientId: string;
  profile: string;
  modelPreset: string;
  codexProfile: string;
  codexModelPreset: string;
  durationMinutes: number;
  restartAfterMinutes: number;
  interventionEveryMinutes: number;
  maxSessions: number;
  leaseTimeoutMs: number;
  reaperIntervalMs: number;
  turnTimeoutMs: number;
}

export interface SoakPaths {
  root: string;
  config: string;
  runtime: string;
  runnerState: string;
  runnerStateStorage: string;
  runnerReleases: string;
  eventOutbox: string;
  incoming: string;
  workspace: string;
  logs: string;
  pids: string;
  captures: string;
  databaseRelease: string;
  agentsConfig: string;
  modelCatalog: string;
  mcpRegistry: string;
  mcpProfiles: string;
  agentProfileCache: string;
  claudeAuthToken: string;
  codexHome: string;
  orchLog: string;
  soulLog: string;
  orchPid: string;
  soulPid: string;
}

export interface ResolvedSoakConfig extends SoakConfigFile {
  repositoryRoot: string;
  paths: SoakPaths;
}

export interface SoakSecrets {
  databaseUrl: string;
  authBearerToken: string;
  claudeAuthTokenPath: string;
  codexHomePath: string;
}

export interface ServiceEnvironments {
  orch: NodeJS.ProcessEnv;
  soul: NodeJS.ProcessEnv;
}

export function resolveSoakConfig(
  value: SoakConfigFile,
  repositoryRoot: string,
): ResolvedSoakConfig {
  if (value.schemaVersion !== 1) throw new Error("unsupported soak config schemaVersion");
  if (value.host !== "127.0.0.1" && value.host !== "localhost") {
    throw new Error("staging soak host must be loopback");
  }
  assertPort(value.orchPort, "orchPort");
  assertPort(value.soulPort, "soulPort");
  if (value.orchPort === value.soulPort) throw new Error("staging ports must be distinct");
  if (!SAFE_DATABASE_NAME.test(value.databaseName)) {
    throw new Error("staging database name must be a dedicated staging/soak identifier");
  }
  for (const key of [
    "databaseAdminUrlEnv",
    "authBearerTokenEnv",
    "claudeAuthTokenPathEnv",
    "codexHomePathEnv",
    "claudeOauthClientId",
    "profile",
    "modelPreset",
    "codexProfile",
    "codexModelPreset",
  ] as const) {
    if (!value[key]?.trim()) throw new Error(`${key} is required`);
  }
  assertPositive(value.durationMinutes, "durationMinutes");
  assertPositive(value.restartAfterMinutes, "restartAfterMinutes");
  assertPositive(value.interventionEveryMinutes, "interventionEveryMinutes");
  assertPositive(value.maxSessions, "maxSessions");
  assertPositive(value.leaseTimeoutMs, "leaseTimeoutMs");
  assertPositive(value.reaperIntervalMs, "reaperIntervalMs");
  assertPositive(value.turnTimeoutMs, "turnTimeoutMs");
  if (!Number.isInteger(value.maxSessions) || value.maxSessions > 2) {
    throw new Error("maxSessions must be one or two on the 8GB staging host");
  }
  if (value.restartAfterMinutes >= value.durationMinutes) {
    throw new Error("restartAfterMinutes must be earlier than durationMinutes");
  }

  const root = resolve(repositoryRoot, value.stagingRoot);
  const ownedRoot = resolve(repositoryRoot, OWNED_ROOT);
  if (!isWithin(root, ownedRoot)) {
    throw new Error(`staging root must stay inside ${OWNED_ROOT}`);
  }
  const paths = derivePaths(root);
  return { ...value, repositoryRoot: resolve(repositoryRoot), stagingRoot: root, paths };
}

export function buildServiceEnvironments(
  config: ResolvedSoakConfig,
  secrets: SoakSecrets,
): ServiceEnvironments {
  for (const [key, value] of Object.entries(secrets)) {
    if (!value.trim()) throw new Error(`${key} is required`);
  }
  const shared = {
    AUTH_BEARER_TOKEN: secrets.authBearerToken,
    ENVIRONMENT: "development",
    HOST: config.host,
    SOUL_RUNNER_PROCESS_ENABLED: "true",
    SOUL_RUNNER_LEASE_TIMEOUT_MS: String(config.leaseTimeoutMs),
  };
  return {
    orch: {
      ...shared,
      PORT: String(config.orchPort),
      NODE_NAME: "runner-staging-soak-orch",
      DATABASE_URL: secrets.databaseUrl,
      CLAUDE_OAUTH_CLIENT_ID: config.claudeOauthClientId,
      CLAUDE_OAUTH_CALLBACK_URL:
        `http://${config.host}:${config.orchPort}/api/auth/claude/callback`,
      ATOM_ENABLED: "false",
      USAGE_SUMMARY_POLL_INTERVAL_SECONDS: "3600",
    },
    soul: {
      ...shared,
      PORT: String(config.soulPort),
      SOULSTREAM_NODE_ID: "runner-staging-soak-node",
      SOULSTREAM_UPSTREAM_URL: `ws://${config.host}:${config.orchPort}/ws/node`,
      EVENT_OUTBOX_DIR: config.paths.eventOutbox,
      SOUL_RUNNER_STATE_DIR: config.paths.runnerState,
      SOUL_RUNNER_ARTIFACT_DIR: join(config.repositoryRoot, "soul-server-ts", "dist", "runner"),
      SOUL_RUNNER_RELEASES_DIR: config.paths.runnerReleases,
      SOUL_RUNNER_REAPER_INTERVAL_MS: String(config.reaperIntervalMs),
      AGENTS_CONFIG_PATH: config.paths.agentsConfig,
      AGENT_PROFILE_CACHE_PATH: config.paths.agentProfileCache,
      MODEL_CATALOG_PATH: config.paths.modelCatalog,
      INCOMING_FILE_DIR: config.paths.incoming,
      CLAUDE_AUTH_TOKEN_PATH: secrets.claudeAuthTokenPath,
      CODEX_HOME: secrets.codexHomePath,
      CODEX_ADAPTER_MODE: "app-server",
      CLAUDE_SESSION_RUNTIME_V2_ENABLED: "true",
      CLAUDE_SESSION_RUNTIME_TURN_TIMEOUT_MS: String(config.turnTimeoutMs),
      ATOM_ENABLED: "false",
      MCP_ENABLED: "true",
      MCP_PATH: "/mcp",
      MCP_STATELESS_TRANSPORT_ENABLED: "true",
      MCP_REQUIRE_AUTH: "true",
      MCP_ALLOWED_HOSTS: "127.0.0.1,localhost",
      SOULSTREAM_MCP_AUTH: `Bearer ${secrets.authBearerToken}`,
    },
  };
}

function derivePaths(root: string): SoakPaths {
  const config = join(root, "config");
  const runtime = join(root, "runtime");
  const logs = join(root, "logs");
  const pids = join(root, "pids");
  const runnerStateStorage = join(runtime, "runner-state");
  const runnerStateAlias = join(
    "/tmp",
    `soul-runner-soak-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`,
  );
  return {
    root,
    config,
    runtime,
    // Linux sockaddr_un is limited to 108 bytes. The worktree path is much
    // longer, so runtime addresses use a short, validated symlink while all
    // durable bytes remain under the owned staging root.
    runnerState: runnerStateAlias,
    runnerStateStorage,
    runnerReleases: join(runtime, "runner-releases"),
    eventOutbox: join(runtime, "event-outbox"),
    incoming: join(runtime, "incoming"),
    workspace: join(root, "workspace"),
    logs,
    pids,
    captures: join(root, "captures"),
    databaseRelease: join(root, "database-release"),
    agentsConfig: join(config, "agents.yaml"),
    modelCatalog: join(config, "model-catalog.yaml"),
    mcpRegistry: join(config, "mcp-registry.yaml"),
    mcpProfiles: join(config, "mcp-profiles.yaml"),
    agentProfileCache: join(runtime, "agent-profiles.json"),
    claudeAuthToken: join(runtime, "claude-auth.json"),
    codexHome: join(runtime, "codex-home"),
    orchLog: join(logs, "orch.log"),
    soulLog: join(logs, "soul.log"),
    orchPid: join(pids, "orch.json"),
    soulPid: join(pids, "soul.json"),
  };
}

function assertPort(port: number, key: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${key} must be an integer port`);
  }
  if (LIVE_PORTS.has(port)) throw new Error(`${key} must not use live port ${port}`);
}

function assertPositive(value: number, key: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be positive`);
}

function isWithin(candidate: string, base: string): boolean {
  const path = relative(base, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
