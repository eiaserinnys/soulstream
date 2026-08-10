import { homedir } from "node:os";
import { join } from "node:path";

import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { Env } from "../config.js";
import type { ClaudeClientEvent } from "../engine/claude_event_mapper.js";
import type {
  EngineRunStateSnapshot,
  EngineSessionItemsSnapshot,
} from "../engine/protocol.js";
import type { CodexCliPathResolution } from "../engine/codex_cli_path.js";
import type { McpConfigService } from "../mcp_config_service.js";
import type { RunnerProcessRuntimeFactory } from "../task/task_executor.js";
import type { EventOutboxPumpMux } from "../upstream/event_outbox_pump_mux.js";
import { createTaskRunnerRuntime } from "./task_runner_runtime.js";
import {
  RunnerProcessDispatcher,
  type RunnerHostCall,
} from "./runner_process_dispatcher.js";
import { RunnerProcessEngineProxy } from "./runner_process_engine_proxy.js";
import { RunnerProcessSpawner } from "./runner_process_spawn.js";

type RunnerEnv = Pick<Env,
  | "SOUL_RUNNER_STATE_DIR"
  | "SOUL_RUNNER_CODE_SHA"
  | "SOUL_RUNNER_SNAPSHOT_PATH"
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
  sessionStore: SessionStore;
  mcpConfigService: McpConfigService;
  codexCliPath?: CodexCliPathResolution;
  buildChildProcessEnv(): NodeJS.ProcessEnv;
  observeClaudeRuntime?(sessionId: string, event: ClaudeClientEvent): Promise<unknown>;
  publishDetachedClaudeEvent?(sessionId: string, event: ClaudeClientEvent): Promise<unknown>;
  spawner?: Pick<RunnerProcessSpawner, "spawn">;
}

export function createRunnerProcessRuntimeFactory(
  options: RunnerProcessRuntimeFactoryOptions,
): RunnerProcessRuntimeFactory {
  const stateDirectory = required(options.env.SOUL_RUNNER_STATE_DIR, "SOUL_RUNNER_STATE_DIR");
  const codeSha = required(options.env.SOUL_RUNNER_CODE_SHA, "SOUL_RUNNER_CODE_SHA");
  const snapshotPath = required(
    options.env.SOUL_RUNNER_SNAPSHOT_PATH,
    "SOUL_RUNNER_SNAPSHOT_PATH",
  );
  const spawner = options.spawner ?? new RunnerProcessSpawner();

  return (task, agent, backend, snapshots) => {
    const resolvedMcpServers = options.mcpConfigService.resolveMcpProfile(agent)?.mcp_servers;
    const childProcessEnv = options.buildChildProcessEnv();
    const codexHome = backend === "codex"
      ? childProcessEnv.CODEX_HOME?.trim() || join(homedir(), ".codex")
      : null;
    const dispatcher = new RunnerProcessDispatcher({
      spawn: {
        stateDirectory,
        sessionId: task.agentSessionId,
        backend,
        agent,
        codeSha,
        snapshotPath,
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
      },
      spawner,
      pumpMux: options.pumpMux,
      logger: options.logger,
      handleHostCall: async (call) => await handleHostCall(
        call,
        task.agentSessionId,
        snapshots,
        options,
      ),
    });
    const engine = new RunnerProcessEngineProxy(backend, agent.workspace_dir, dispatcher);
    return createTaskRunnerRuntime(engine, dispatcher, "runner");
  };
}

async function handleHostCall(
  call: RunnerHostCall,
  expectedSessionId: string,
  snapshots: {
    persistRunState(snapshot: EngineRunStateSnapshot): Promise<void>;
    persistSessionItems(snapshot: EngineSessionItemsSnapshot): Promise<void>;
  },
  options: RunnerProcessRuntimeFactoryOptions,
): Promise<unknown> {
  if (call.service === "session_store") {
    return await callSessionStore(options.sessionStore, call.operation, call.args);
  }
  const sessionId = asString(call.args[0], "runner host session id");
  if (sessionId !== expectedSessionId) {
    throw new Error(`runner host session mismatch: ${sessionId}`);
  }
  if (call.service === "snapshot") {
    if (call.operation === "persistRunState") {
      await snapshots.persistRunState(call.args[1] as EngineRunStateSnapshot);
      return null;
    }
    if (call.operation === "persistSessionItems") {
      await snapshots.persistSessionItems(call.args[1] as EngineSessionItemsSnapshot);
      return null;
    }
    throw new Error(`unsupported snapshot host operation: ${call.operation}`);
  }
  const event = call.args[1] as ClaudeClientEvent;
  if (call.service === "claude_runtime" && call.operation === "observe") {
    return await options.observeClaudeRuntime?.(sessionId, event) ?? true;
  }
  if (call.service === "detached_event" && call.operation === "publish") {
    await options.publishDetachedClaudeEvent?.(sessionId, event);
    return null;
  }
  throw new Error(`unsupported runner host call: ${call.service}.${call.operation}`);
}

async function callSessionStore(
  store: SessionStore,
  operation: string,
  args: unknown[],
): Promise<unknown> {
  switch (operation) {
    case "append":
      await store.append(args[0] as SessionKey, args[1] as SessionStoreEntry[]);
      return null;
    case "load":
      return await store.load(args[0] as SessionKey);
    case "listSessions":
      if (!store.listSessions) throw new Error("SessionStore.listSessions unavailable");
      return await store.listSessions(asString(args[0], "project key"));
    case "delete":
      await store.delete?.(args[0] as SessionKey);
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
