import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";
import type {
  ClaudeAccountRejectInput,
  ClaudeAccountReleaseInput,
  ClaudeAccountSelectionInput,
  ClaudeAccountSelectionResponse,
} from "../claude_accounts/types.js";
import type { ClaudeAccountTurnPort } from "../engine/claude_account_pool.js";

import { join } from "node:path";

import { AgentsEngineAdapter } from "../engine/agents_adapter.js";
import { AntigravityEngineAdapter } from "../engine/antigravity/adapter.js";
import { OpenCodeEngineAdapter } from "../engine/opencode/adapter.js";
import {
  ClaudeEngineAdapter,
  ClaudeSdkClient,
  claudeEngineEventMetadata,
} from "../engine/claude_adapter.js";
import { ClaudeSessionClientRegistry } from
  "../engine/claude_session_client_registry.js";
import { CodexEngineAdapter } from "../engine/codex_adapter.js";
import { CodexAppServerEngineAdapter } from "../engine/codex_app_server/index.js";
import type { EngineExecuteParams, EnginePort, SSEEventPayload } from "../engine/protocol.js";
import type { RunnerChildConfig } from "./runner_process_spawn.js";
import { SessionIsolationUnavailableError } from "./session_filesystem_errors.js";
import type { RunnerHostRequestClient } from "./runner_host_request_client.js";
import {
  applyRunnerClaudeRuntimeObservationResult,
} from "./runner_claude_runtime_observation.js";
import { RunnerClaudeAccountTurnStateStore } from "./claude_account_turn_state_store.js";

const HOST_REQUEST_ATTEMPT_TIMEOUT_MS = 1_800_000;
const HOST_REQUEST_DEADLINE_MS = HOST_REQUEST_ATTEMPT_TIMEOUT_MS;

export function createRunnerChildEngine(
  config: RunnerChildConfig,
  host: RunnerHostRequestClient,
  logger: Logger,
): EnginePort {
  assertIsolatableBackend(config);
  const engine = createRunnerChildEnginePort(config, host, logger);
  return config.isolation
    ? withIsolationContextNotice(engine, config.isolation.contextNotice)
    : engine;
}

function createRunnerChildEnginePort(
  config: RunnerChildConfig,
  host: RunnerHostRequestClient,
  logger: Logger,
): EnginePort {
  if (config.backend === "antigravity") {
    return new AntigravityEngineAdapter({
      workspaceDir: config.agent.workspace_dir,
      agentId: config.agent.id,
      sessionDirectory: config.paths.sessionDirectory,
      executablePath: config.antigravityCliPath,
      processEnv: process.env,
      resolvedMcpServers: config.resolvedMcpServers,
      internalMcpUrl: config.internalMcpUrl,
    }, logger);
  }
  if (config.backend === "opencode") {
    return new OpenCodeEngineAdapter({
      workspaceDir: config.agent.workspace_dir,
      agentId: config.agent.id,
      // B2는 runner state를 가리고 sandbox만 다시 연다. restricted CLI의
      // 설정·지시·XDG 디렉터리는 그 sandbox 안에서 만들어야 읽힌다.
      sessionDirectory: config.isolation
        ? join(config.isolation.spec.sandboxDirectory, "opencode")
        : config.paths.sessionDirectory,
      executablePath: config.opencodeCliPath,
      processEnv: process.env,
      resolvedMcpServers: config.resolvedMcpServers,
      internalMcpUrl: config.internalMcpUrl,
      ...(config.isolation ? { isolation: config.isolation } : {}),
    }, logger);
  }
  if (config.backend === "codex") {
    if (config.codexAdapterMode === "app-server") {
      return new CodexAppServerEngineAdapter({
        workspaceDir: config.agent.workspace_dir,
        agentId: config.agent.id,
        apiKey: process.env.CODEX_API_KEY,
        codexPathOverride: config.codexCliPath,
        processEnv: process.env,
        requestTimeoutMs: config.codexAppServerRequestTimeoutMs,
        startupRequestTimeoutMs: config.codexAppServerStartupTimeoutMs,
        internalMcpUrl: config.internalMcpUrl,
        codexDetachedResultRetentionMs: config.codexDetachedResultRetentionMs,
        ...(config.resolvedMcpServers
          ? { resolvedMcpServers: config.resolvedMcpServers }
          : {}),
        ...(config.isolation ? { isolation: config.isolation } : {}),
      }, logger);
    }
    if (config.resolvedMcpServers) {
      throw new Error(
        `Codex agent ${config.agent.id} with MCP servers requires app-server mode`,
      );
    }
    return new CodexEngineAdapter({
      workspaceDir: config.agent.workspace_dir,
      agentId: config.agent.id,
      apiKey: process.env.CODEX_API_KEY,
      processEnv: process.env,
      codexPathOverride: config.codexCliPath,
    }, logger);
  }
  if (config.backend === "openai-agents") {
    return new AgentsEngineAdapter({
      workspaceDir: config.agent.workspace_dir,
      profile: config.agent,
      processEnv: process.env,
    }, logger);
  }

  if (config.backend !== "claude") {
    throw new Error(`Unsupported backend "${config.backend}" in runner child`);
  }
  const sessionStore = new HostSessionStore(host);
  const accountPoolEnabled = config.claudeAccountPool?.enabled === true;
  const claudeAccountTurnPort = accountPoolEnabled
    ? new HostClaudeAccountTurnPort(host)
    : undefined;
  const registry = config.claudeRuntimeV2Enabled || accountPoolEnabled
    ? new ClaudeSessionClientRegistry(
        (sessionId) => new ClaudeSdkClient({
          ...(config.claudeRuntimeV2Enabled
            ? {
                runtimeEventSink: async (event) => {
                  const metadata = claudeEngineEventMetadata(event);
                  const result = await host.call(
                    "claude_runtime",
                    "observe",
                    [sessionId, { ...event }, ...(metadata ? [metadata] : [])],
                    hostOptions(),
                  );
                  return applyRunnerClaudeRuntimeObservationResult(
                    event,
                    result,
                    (issue) => logger.error(
                      { err: issue, sessionId },
                      "Runner Claude runtime observation response violated its semantic contract",
                    ),
                  );
                },
                detachedEventSink: async (event) => {
                  const metadata = claudeEngineEventMetadata(event);
                  await host.call(
                    "detached_event",
                    "publish",
                    [sessionId, { ...event }, ...(metadata ? [metadata] : [])],
                    hostOptions(),
                  );
                },
              }
            : {}),
          persistentTurnInactivityTimeoutMs: config.claudeRuntimeTurnTimeoutMs,
        }, logger),
        {
          idleTtlMs: config.claudeRuntimeIdleTtlMs,
          maxEntries: config.claudeRuntimeMaxEntries,
          logger,
          ...(claudeAccountTurnPort
            ? {
                onClientClosed: async (sessionId) => {
                  await claudeAccountTurnPort.release({
                    session_id: sessionId,
                    clear_all: true,
                  });
                },
              }
            : {}),
        },
      )
    : undefined;
  return new ClaudeEngineAdapter({
    workspaceDir: config.agent.workspace_dir,
    agentId: config.agent.id,
    processEnv: process.env,
    sessionStore,
    sessionStoreFlush: config.claudeRuntimeV2Enabled || accountPoolEnabled ? "eager" : "batched",
    loadTimeoutMs: 60_000,
    trackChildExit: accountPoolEnabled,
    claudeAccountPoolEnabled: accountPoolEnabled,
    ...(accountPoolEnabled
      ? {
          claudeAccountTurnPort: claudeAccountTurnPort!,
          claudeAccountTurnState: RunnerClaudeAccountTurnStateStore.open(
            config.paths.databasePath,
            config.sessionId,
          ),
        }
      : {}),
    internalMcpUrl: config.internalMcpUrl,
    ...(config.resolvedMcpServers
      ? { resolvedMcpServers: config.resolvedMcpServers }
      : {}),
    ...(registry ? { persistentSessionRegistry: registry } : {}),
    ...(config.isolation ? { isolation: config.isolation } : {}),
  }, logger);
}

/** 격리를 지원하는 러너 경로가 있는 backend만 통과시킨다. */
function assertIsolatableBackend(config: RunnerChildConfig): void {
  if (!config.isolation) return;
  if (config.backend === "claude" || config.backend === "opencode") return;
  if (config.backend === "codex" && config.codexAdapterMode === "app-server") return;
  throw new SessionIsolationUnavailableError(
    `SESSION_ISOLATION_UNAVAILABLE: backend ${config.backend} has no isolated runner path`,
  );
}

/**
 * 새 restricted 러너의 첫 턴에만 격리 안내를 앞에 붙인다. 러너를 재사용하는
 * 턴에는 붙지 않고, 정책·attach 변경으로 러너가 다시 만들어지면 다시 붙는다.
 */
function withIsolationContextNotice(engine: EnginePort, notice: string): EnginePort {
  let pending = true;
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === "execute") {
        return (params: EngineExecuteParams): AsyncIterable<SSEEventPayload> => {
          const first = pending;
          pending = false;
          return target.execute(first
            ? { ...params, prompt: `${notice}\n\n${params.prompt}` }
            : params);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as EnginePort;
}

class HostClaudeAccountTurnPort implements ClaudeAccountTurnPort {
  constructor(private readonly host: RunnerHostRequestClient) {}

  async select(input: ClaudeAccountSelectionInput): Promise<ClaudeAccountSelectionResponse> {
    return await this.host.call(
      "claude_accounts",
      "select",
      [input.session_id, input],
      hostOptions(),
    ) as ClaudeAccountSelectionResponse;
  }

  async reject(input: ClaudeAccountRejectInput): Promise<void> {
    await this.host.call("claude_accounts", "reject", [input.session_id, input], hostOptions());
  }

  async release(input: ClaudeAccountReleaseInput): Promise<void> {
    await this.host.call("claude_accounts", "release", [input.session_id, input], hostOptions());
  }
}

class HostSessionStore implements SessionStore {
  constructor(private readonly host: RunnerHostRequestClient) {}

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    await this.host.call("session_store", "append", [key, entries], hostOptions());
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return await this.host.call("session_store", "load", [key], hostOptions()) as
      SessionStoreEntry[] | null;
  }

  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    return await this.host.call(
      "session_store",
      "listSessions",
      [projectKey],
      hostOptions(),
    ) as Array<{ sessionId: string; mtime: number }>;
  }

  async delete(key: SessionKey): Promise<void> {
    await this.host.call("session_store", "delete", [key], hostOptions());
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    return await this.host.call("session_store", "listSubkeys", [key], hostOptions()) as string[];
  }
}

function hostOptions() {
  return {
    timeoutMs: HOST_REQUEST_ATTEMPT_TIMEOUT_MS,
    deadlineMs: HOST_REQUEST_DEADLINE_MS,
    retryDelayMs: 500,
  };
}
