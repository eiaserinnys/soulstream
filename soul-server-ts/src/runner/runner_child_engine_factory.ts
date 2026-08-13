import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import { AgentsEngineAdapter } from "../engine/agents_adapter.js";
import {
  ClaudeEngineAdapter,
  ClaudeSdkClient,
  claudeEngineEventMetadata,
} from "../engine/claude_adapter.js";
import { ClaudeSessionClientRegistry } from
  "../engine/claude_session_client_registry.js";
import { CodexEngineAdapter } from "../engine/codex_adapter.js";
import { CodexAppServerEngineAdapter } from "../engine/codex_app_server/index.js";
import type { EnginePort } from "../engine/protocol.js";
import type { RunnerChildConfig } from "./runner_process_spawn.js";
import type { RunnerHostRequestClient } from "./runner_host_request_client.js";

const HOST_REQUEST_TIMEOUT_MS = 30_000;

export function createRunnerChildEngine(
  config: RunnerChildConfig,
  host: RunnerHostRequestClient,
  logger: Logger,
): EnginePort {
  if (config.backend === "codex") {
    if (config.codexAdapterMode === "app-server") {
      return new CodexAppServerEngineAdapter({
        workspaceDir: config.agent.workspace_dir,
        agentId: config.agent.id,
        apiKey: process.env.CODEX_API_KEY,
        codexPathOverride: config.codexCliPath,
        processEnv: process.env,
        internalMcpUrl: config.internalMcpUrl,
        ...(config.resolvedMcpServers
          ? { resolvedMcpServers: config.resolvedMcpServers }
          : {}),
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

  const sessionStore = new HostSessionStore(host);
  const registry = config.claudeRuntimeV2Enabled
    ? new ClaudeSessionClientRegistry(
        (sessionId) => new ClaudeSdkClient({
          runtimeEventSink: async (event) => {
            const metadata = claudeEngineEventMetadata(event);
            await host.call(
              "claude_runtime",
              "observe",
              [sessionId, { ...event }, ...(metadata ? [metadata] : [])],
              hostOptions(),
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
          persistentTurnTimeoutMs: config.claudeRuntimeTurnTimeoutMs,
        }, logger),
        {
          idleTtlMs: config.claudeRuntimeIdleTtlMs,
          maxEntries: config.claudeRuntimeMaxEntries,
          logger,
        },
      )
    : undefined;
  return new ClaudeEngineAdapter({
    workspaceDir: config.agent.workspace_dir,
    agentId: config.agent.id,
    processEnv: process.env,
    sessionStore,
    sessionStoreFlush: config.claudeRuntimeV2Enabled ? "eager" : "batched",
    loadTimeoutMs: 60_000,
    internalMcpUrl: config.internalMcpUrl,
    ...(config.resolvedMcpServers
      ? { resolvedMcpServers: config.resolvedMcpServers }
      : {}),
    ...(registry ? { persistentSessionRegistry: registry } : {}),
  }, logger);
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
    timeoutMs: HOST_REQUEST_TIMEOUT_MS,
    attempts: 61,
    retryDelayMs: 500,
  };
}
