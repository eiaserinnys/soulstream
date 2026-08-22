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
import {
  buildRunnerClaudeRuntimeObservationResult,
} from "./runner_claude_runtime_observation.js";
import type { CodexCliPathResolution } from "../engine/codex_cli_path.js";
import type { IdempotentClaudeSessionStore } from "../engine/claude_session_store.js";
import type { McpConfigService } from "../mcp_config_service.js";
import { localInternalMcpUrl } from "../mcp/endpoint_paths.js";
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
import type { NodeStallMonitor } from "../runtime/node_stall_monitor.js";
import type { ReleaseManifestV1 } from "../release/release_manifest.js";
import { agentRuntimeEnvIdentity } from "../release/release_env.js";

type RunnerEnv = Pick<Env,
  | "SOUL_RUNNER_STATE_DIR"
  | "SOUL_RUNNER_ARTIFACT_DIR"
  | "SOUL_RUNNER_RELEASES_DIR"
  | "SOUL_RUNNER_TERMINAL_RETENTION_MS"
  | "SOUL_RUNNER_LEASE_TIMEOUT_MS"
  | "CODEX_ADAPTER_MODE"
  | "CLAUDE_SESSION_RUNTIME_V2_ENABLED"
  | "CLAUDE_SESSION_RUNTIME_IDLE_TTL_MS"
  | "CLAUDE_SESSION_RUNTIME_MAX_ENTRIES"
  | "CLAUDE_SESSION_RUNTIME_TURN_TIMEOUT_MS"
  | "MCP_INTERNAL_PORT"
  | "MCP_PATH"
>;

export interface RunnerProcessRuntimeFactoryOptions {
  env: RunnerEnv;
  logger: Logger;
  pumpMux: EventOutboxPumpMux;
  sessionStore: IdempotentClaudeSessionStore;
  mcpConfigService: McpConfigService;
  codexCliPath?: CodexCliPathResolution;
  releasePool: Pick<RunnerReleasePool, "resolveCurrentRelease" | "ensureRelease" | "describe">;
  releaseManifest?: ReleaseManifestV1;
  nodeStallMonitor?: Pick<
    NodeStallMonitor,
    "beginRunnerOperation" | "sqliteTransactionObserver"
  >;
  buildChildProcessEnv(): NodeJS.ProcessEnv;
  observeClaudeRuntime?(
    sessionId: string,
    event: ClaudeClientEvent,
    idempotencyKey: string,
  ): Promise<boolean>;
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
  const spawner = options.spawner ?? new RunnerProcessSpawner(undefined, options.logger);

  const createRuntime = (
    task: Task,
    agent: import("../agent_registry.js").AgentProfile,
    backend: import("../engine/protocol.js").BackendId,
    snapshots: RunnerSnapshotPersistence,
    spawn: SpawnRunnerProcessInput | Promise<SpawnRunnerProcessInput>,
    recoveryMode?: "adopt" | "replay" | "offline",
  ) => {
    const dispatcher = new RunnerProcessDispatcher({
      spawn,
      adoptExisting: recoveryMode === "adopt" || recoveryMode === "replay",
      offlineExisting: recoveryMode === "offline",
      spawner,
      pumpMux: options.pumpMux,
      logger: options.logger,
      ...(options.nodeStallMonitor ? { nodeStallMonitor: options.nodeStallMonitor } : {}),
      handleHostCall: async (call) => await applyRunnerHostCall(
        call,
        task.agentSessionId,
        snapshots,
        options,
      ),
    });
    const engine = new RunnerProcessEngineProxy(
      backend,
      agent.workspace_dir,
      dispatcher,
      // Offline recovery owns stopped durable files, never a detached child
      // runtime. Advertising retention here strands the host writer lock.
      { retainDetachedRuntime: recoveryMode !== "offline" },
    );
    return createTaskRunnerRuntime(engine, dispatcher, "runner");
  };

  const factory = ((task, agent, backend, snapshots) => {
    const runtimeMcpConfig = resolveRuntimeMcpConfig(options, agent);
    const childProcessEnv = options.buildChildProcessEnv();
    const codexHome = backend === "codex"
      ? childProcessEnv.CODEX_HOME?.trim() || join(homedir(), ".codex")
      : null;
    return createRuntime(
      task,
      agent,
      backend,
      snapshots,
      Promise.resolve().then(() => {
        if (options.releaseManifest
          && task.executionOwnershipReservation
          && task.executionOwnershipReservation.manifestId
            !== options.releaseManifest.manifest_id) {
          throw new Error(
            `execution reservation release manifest mismatch: ${task.executionOwnershipReservation.manifestId}`,
          );
        }
        return options.releaseManifest
          ? options.releasePool.describe(options.releaseManifest.runner_release_id)
          : options.releasePool.resolveCurrentRelease();
      }).then((release) => ({
        stateDirectory,
        sessionId: task.agentSessionId,
        backend,
        agent,
        // `codeSha` is a legacy field name for the opaque release id.
        codeSha: release.releaseId,
        releaseManifestId: options.releaseManifest?.manifest_id ?? release.releaseId,
        runtimeEnvIdentity: agentRuntimeEnvIdentity(agent),
        snapshotPath: release.runnerModuleRoot,
        codexAdapterMode: options.env.CODEX_ADAPTER_MODE,
        codexCliPath: options.codexCliPath?.path,
        claudeRuntimeV2Enabled: options.env.CLAUDE_SESSION_RUNTIME_V2_ENABLED,
        claudeRuntimeIdleTtlMs: options.env.CLAUDE_SESSION_RUNTIME_IDLE_TTL_MS,
        claudeRuntimeMaxEntries: options.env.CLAUDE_SESSION_RUNTIME_MAX_ENTRIES,
        claudeRuntimeTurnTimeoutMs: options.env.CLAUDE_SESSION_RUNTIME_TURN_TIMEOUT_MS,
        runnerLeaseTimeoutMs: options.env.SOUL_RUNNER_LEASE_TIMEOUT_MS,
        ...runtimeMcpConfig,
        codexHome,
        rolloutRoot: codexHome ? join(codexHome, "sessions") : null,
        childProcessEnv,
        prepareSnapshot: async () => await options.releasePool.ensureRelease(release),
      })),
    );
  }) as RunnerProcessRuntimeFactory;
  factory.describe = async (agent) => {
    const release = options.releaseManifest
      ? null
      : await options.releasePool.resolveCurrentRelease();
    return {
      ownerKind: "runner_process",
      manifestId: options.releaseManifest?.manifest_id ?? release!.releaseId,
      runtimeEnvIdentity: agentRuntimeEnvIdentity(agent),
    };
  };
  // Adoption, live terminal replay, and offline replay reuse the registered
  // child/config rather than resolving current profile MCP settings.
  factory.recover = (task, config, snapshots, mode = "adopt") => createRuntime(
    task,
    config.agent,
    config.backend,
    snapshots,
    spawnInputFromConfig(
      stateDirectory,
      config,
      options.env.SOUL_RUNNER_LEASE_TIMEOUT_MS,
      options.releasePool,
      storedRuntimeMcpConfig(config),
    ),
    mode,
  );
  // A replacement child keeps the original release snapshot but binds to the
  // host's current runtime MCP endpoints and resolved profile.
  factory.restart = (task, config, snapshots) => createRuntime(
    task,
    config.agent,
    config.backend,
    snapshots,
    spawnInputFromConfig(
      stateDirectory,
      config,
      options.env.SOUL_RUNNER_LEASE_TIMEOUT_MS,
      options.releasePool,
      resolveRuntimeMcpConfig(options, config.agent),
    ),
  );
  return factory;
}

function spawnInputFromConfig(
  stateDirectory: string,
  config: RunnerChildConfig,
  runnerLeaseTimeoutMs: number,
  releasePool: Pick<RunnerReleasePool, "ensureRelease" | "describe">,
  runtimeMcpConfig: RunnerRuntimeMcpConfig,
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
    ...(config.releaseManifestId ? { releaseManifestId: config.releaseManifestId } : {}),
    ...(config.runtimeEnvIdentity ? { runtimeEnvIdentity: config.runtimeEnvIdentity } : {}),
    snapshotPath: config.snapshotPath,
    codexAdapterMode: config.codexAdapterMode,
    ...(config.codexCliPath ? { codexCliPath: config.codexCliPath } : {}),
    claudeRuntimeV2Enabled: config.claudeRuntimeV2Enabled,
    claudeRuntimeIdleTtlMs: config.claudeRuntimeIdleTtlMs,
    claudeRuntimeMaxEntries: config.claudeRuntimeMaxEntries,
    claudeRuntimeTurnTimeoutMs: config.claudeRuntimeTurnTimeoutMs,
    runnerLeaseTimeoutMs,
    ...runtimeMcpConfig,
    codexHome: config.codexHome,
    rolloutRoot: config.rolloutRoot,
    prepareSnapshot: async () => await releasePool.ensureRelease(release),
  };
}

type RunnerRuntimeMcpConfig = Pick<
  SpawnRunnerProcessInput,
  "internalMcpUrl" | "resolvedMcpServers"
>;

function resolveRuntimeMcpConfig(
  options: Pick<RunnerProcessRuntimeFactoryOptions, "env" | "mcpConfigService">,
  agent: import("../agent_registry.js").AgentProfile,
): RunnerRuntimeMcpConfig {
  const resolvedMcpServers = options.mcpConfigService
    .resolveMcpProfile(agent)?.mcp_servers;
  return {
    internalMcpUrl: localInternalMcpUrl(
      options.env.MCP_INTERNAL_PORT,
      options.env.MCP_PATH,
    ),
    ...(resolvedMcpServers ? { resolvedMcpServers } : {}),
  };
}

function storedRuntimeMcpConfig(
  config: RunnerChildConfig,
): RunnerRuntimeMcpConfig {
  return {
    internalMcpUrl: config.internalMcpUrl,
    ...(config.resolvedMcpServers
      ? { resolvedMcpServers: config.resolvedMcpServers }
      : {}),
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
    const accepted =
      await options.observeClaudeRuntime?.(sessionId, event, call.correlationId) !== false;
    return buildRunnerClaudeRuntimeObservationResult(accepted, event);
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
