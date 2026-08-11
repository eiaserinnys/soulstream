import { homedir } from "node:os";
import { join } from "node:path";

import type {
  SessionKey,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { Env } from "../config.js";
import type { ClaudeClientEvent } from "../engine/claude_event_mapper.js";
import type {
  EngineRunStateSnapshot,
  EngineSessionItemsSnapshot,
} from "../engine/protocol.js";
import { restoreRunnerEngineEventMetadata } from "./engine_event_stream.js";
import type { CodexCliPathResolution } from "../engine/codex_cli_path.js";
import type { IdempotentClaudeSessionStore } from "../engine/claude_session_store.js";
import type { McpConfigService } from "../mcp_config_service.js";
import type {
  RunnerProcessRuntimeFactory,
  RunnerSnapshotPersistence,
} from "../task/task_executor.js";
import type { Task } from "../task/task_models.js";
import type { EventOutboxPumpMux } from "../upstream/event_outbox_pump_mux.js";
import { createTaskRunnerRuntime } from "./task_runner_runtime.js";
import {
  RunnerProcessDispatcher,
  type RunnerHostCall,
} from "./runner_process_dispatcher.js";
import { RunnerProcessEngineProxy } from "./runner_process_engine_proxy.js";
import { RunnerProcessSpawner } from "./runner_process_spawn.js";
import type { RunnerChildConfig, SpawnRunnerProcessInput } from "./runner_process_spawn.js";
import type { RunnerReleasePool } from "./runner_release_pool.js";

type RunnerEnv = Pick<Env,
  | "SOUL_RUNNER_STATE_DIR"
  | "SOUL_RUNNER_ARTIFACT_DIR"
  | "SOUL_RUNNER_RELEASES_DIR"
  | "CODEX_ADAPTER_MODE"
  | "CLAUDE_SESSION_RUNTIME_V2_ENABLED"
  | "CLAUDE_SESSION_RUNTIME_IDLE_TTL_MS"
  | "CLAUDE_SESSION_RUNTIME_MAX_ENTRIES"
  | "CLAUDE_SESSION_RUNTIME_TURN_TIMEOUT_MS"
>;

export interface RunnerProcessRuntimeFactoryOptions {
  env: RunnerEnv;
  logger: Logger;
  pumpMux: EventOutboxPumpMux;
  sessionStore: IdempotentClaudeSessionStore;
  mcpConfigService: McpConfigService;
  codexCliPath?: CodexCliPathResolution;
  releasePool: Pick<RunnerReleasePool, "resolveCurrentRelease" | "ensureRelease" | "describe">;
  buildChildProcessEnv(): NodeJS.ProcessEnv;
  observeClaudeRuntime?(
    sessionId: string,
    event: ClaudeClientEvent,
    idempotencyKey: string,
  ): Promise<unknown>;
  publishDetachedClaudeEvent?(
    sessionId: string,
    event: ClaudeClientEvent,
    idempotencyKey: string,
  ): Promise<unknown>;
  spawner?: Pick<RunnerProcessSpawner, "spawn">;
}

export function createRunnerProcessRuntimeFactory(
  options: RunnerProcessRuntimeFactoryOptions,
): RunnerProcessRuntimeFactory {
  const stateDirectory = required(options.env.SOUL_RUNNER_STATE_DIR, "SOUL_RUNNER_STATE_DIR");
  const spawner = options.spawner ?? new RunnerProcessSpawner();

  const createRuntime = (
    task: Task,
    agent: import("../agent_registry.js").AgentProfile,
    backend: import("../engine/protocol.js").BackendId,
    snapshots: RunnerSnapshotPersistence,
    spawn: SpawnRunnerProcessInput | Promise<SpawnRunnerProcessInput>,
    recoveryMode?: "adopt" | "offline",
  ) => {
    const dispatcher = new RunnerProcessDispatcher({
      spawn,
      adoptExisting: recoveryMode === "adopt",
      offlineExisting: recoveryMode === "offline",
      spawner,
      pumpMux: options.pumpMux,
      logger: options.logger,
      handleHostCall: async (call) => await applyRunnerHostCall(
        call,
        task.agentSessionId,
        snapshots,
        options,
      ),
    });
    const engine = new RunnerProcessEngineProxy(backend, agent.workspace_dir, dispatcher);
    return createTaskRunnerRuntime(engine, dispatcher, "runner");
  };

  const factory = ((task, agent, backend, snapshots) => {
    const resolvedMcpServers = options.mcpConfigService.resolveMcpProfile(agent)?.mcp_servers;
    const childProcessEnv = options.buildChildProcessEnv();
    const codexHome = backend === "codex"
      ? childProcessEnv.CODEX_HOME?.trim() || join(homedir(), ".codex")
      : null;
    return createRuntime(
      task,
      agent,
      backend,
      snapshots,
      options.releasePool.resolveCurrentRelease().then((release) => ({
        stateDirectory,
        sessionId: task.agentSessionId,
        backend,
        agent,
        // `codeSha` is a legacy field name for the opaque release id.
        codeSha: release.releaseId,
        snapshotPath: release.runnerModuleRoot,
        codexAdapterMode: options.env.CODEX_ADAPTER_MODE,
        codexCliPath: options.codexCliPath?.path,
        claudeRuntimeV2Enabled: options.env.CLAUDE_SESSION_RUNTIME_V2_ENABLED,
        claudeRuntimeIdleTtlMs: options.env.CLAUDE_SESSION_RUNTIME_IDLE_TTL_MS,
        claudeRuntimeMaxEntries: options.env.CLAUDE_SESSION_RUNTIME_MAX_ENTRIES,
        claudeRuntimeTurnTimeoutMs: options.env.CLAUDE_SESSION_RUNTIME_TURN_TIMEOUT_MS,
        ...(resolvedMcpServers ? { resolvedMcpServers } : {}),
        codexHome,
        rolloutRoot: codexHome ? join(codexHome, "sessions") : null,
        childProcessEnv,
        prepareSnapshot: async () => await options.releasePool.ensureRelease(release),
      })),
    );
  }) as RunnerProcessRuntimeFactory;
  factory.recover = (task, config, snapshots, mode = "adopt") => createRuntime(
    task,
    config.agent,
    config.backend,
    snapshots,
    spawnInputFromConfig(stateDirectory, config, options.releasePool),
    mode,
  );
  factory.restart = (task, config, snapshots) => createRuntime(
    task,
    config.agent,
    config.backend,
    snapshots,
    spawnInputFromConfig(stateDirectory, config, options.releasePool),
  );
  return factory;
}

function spawnInputFromConfig(
  stateDirectory: string,
  config: RunnerChildConfig,
  releasePool: Pick<RunnerReleasePool, "ensureRelease" | "describe">,
): SpawnRunnerProcessInput {
  const release = releasePool.describe(config.codeSha);
  if (release.runnerModuleRoot !== config.snapshotPath) {
    throw new Error(`runner snapshot path does not match release id: ${config.codeSha}`);
  }
  return {
    stateDirectory,
    sessionId: config.sessionId,
    backend: config.backend,
    agent: config.agent,
    codeSha: config.codeSha,
    snapshotPath: config.snapshotPath,
    codexAdapterMode: config.codexAdapterMode,
    ...(config.codexCliPath ? { codexCliPath: config.codexCliPath } : {}),
    claudeRuntimeV2Enabled: config.claudeRuntimeV2Enabled,
    claudeRuntimeIdleTtlMs: config.claudeRuntimeIdleTtlMs,
    claudeRuntimeMaxEntries: config.claudeRuntimeMaxEntries,
    claudeRuntimeTurnTimeoutMs: config.claudeRuntimeTurnTimeoutMs,
    ...(config.resolvedMcpServers
      ? { resolvedMcpServers: config.resolvedMcpServers }
      : {}),
    codexHome: config.codexHome,
    rolloutRoot: config.rolloutRoot,
    prepareSnapshot: async () => await releasePool.ensureRelease(release),
  };
}

export async function applyRunnerHostCall(
  call: RunnerHostCall,
  expectedSessionId: string,
  snapshots: {
    persistRunState(
      snapshot: EngineRunStateSnapshot,
      idempotencyKey?: string,
    ): Promise<void>;
    persistSessionItems(
      snapshot: EngineSessionItemsSnapshot,
      idempotencyKey?: string,
    ): Promise<void>;
  },
  options: RunnerProcessRuntimeFactoryOptions,
): Promise<unknown> {
  if (call.service === "session_store") {
    return await callSessionStore(
      options.sessionStore,
      call.operation,
      call.args,
      call.correlationId,
      expectedSessionId,
    );
  }
  const sessionId = asString(call.args[0], "runner host session id");
  if (sessionId !== expectedSessionId) {
    throw new Error(`runner host session mismatch: ${sessionId}`);
  }
  if (call.service === "snapshot") {
    if (call.operation === "persistRunState") {
      await snapshots.persistRunState(
        call.args[1] as EngineRunStateSnapshot,
        call.correlationId,
      );
      return null;
    }
    if (call.operation === "persistSessionItems") {
      await snapshots.persistSessionItems(
        call.args[1] as EngineSessionItemsSnapshot,
        call.correlationId,
      );
      return null;
    }
    throw new Error(`unsupported snapshot host operation: ${call.operation}`);
  }
  const event = call.args[1] as ClaudeClientEvent;
  restoreRunnerEngineEventMetadata(event, call.args[2]);
  if (call.service === "claude_runtime" && call.operation === "observe") {
    return await options.observeClaudeRuntime?.(sessionId, event, call.correlationId) ?? true;
  }
  if (call.service === "detached_event" && call.operation === "publish") {
    await options.publishDetachedClaudeEvent?.(sessionId, event, call.correlationId);
    return null;
  }
  throw new Error(`unsupported runner host call: ${call.service}.${call.operation}`);
}

async function callSessionStore(
  store: IdempotentClaudeSessionStore,
  operation: string,
  args: unknown[],
  idempotencyKey: string,
  ownerSessionId: string,
): Promise<unknown> {
  switch (operation) {
    case "append":
      await store.appendIdempotent(
        args[0] as SessionKey,
        args[1] as SessionStoreEntry[],
        idempotencyKey,
        ownerSessionId,
      );
      return null;
    case "load":
      return await store.load(args[0] as SessionKey);
    case "listSessions":
      if (!store.listSessions) throw new Error("SessionStore.listSessions unavailable");
      return await store.listSessions(asString(args[0], "project key"));
    case "delete":
      await store.deleteIdempotent(
        args[0] as SessionKey,
        idempotencyKey,
        ownerSessionId,
      );
      return null;
    case "listSubkeys":
      if (!store.listSubkeys) throw new Error("SessionStore.listSubkeys unavailable");
      return await store.listSubkeys(args[0] as { projectKey: string; sessionId: string });
    default:
      throw new Error(`unsupported SessionStore operation: ${operation}`);
  }
}

function required(value: string | undefined, key: string): string {
  if (!value) throw new Error(`${key} required for runner process mode`);
  return value;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} required`);
  return value;
}
