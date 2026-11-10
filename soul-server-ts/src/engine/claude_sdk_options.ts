import type {
  Options as ClaudeSdkOptions,
  SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { RunnerIsolationChildConfig } from "../runner/runner_isolation_config.js";
import type { ClaudeRunOptions } from "./claude_adapter.js";
import type { ClaudeClientEvent } from "./claude_client_event.js";
import type { EventQueue } from "./claude_sdk_event_queue.js";
import type { ClaudeSdkEventMapper } from "./claude_sdk_event_mapper.js";
import { buildClaudeSdkHooks } from "./claude_sdk_hooks.js";
import { externalizeClaudeMcpConfig } from "./claude_mcp_config_file.js";
import { buildMcpOptions } from "./claude_sdk_mcp_options.js";
import { makeCacheableSystemPrompt } from "./claude_sdk_prompt.js";
import type { ClaudeRuntimeState } from "./claude_sdk_runtime_state.js";
import type { ClaudeSdkToolPermissionController } from "./claude_sdk_tool_permissions.js";
import { isolationError, launchIsolatedChild } from "./isolated_session_launch.js";
import { spawnClaudeSessionEngine } from "./session_engine_oom_score.js";

const CLAUDE_CODE_EXECPATH_ENV = "CLAUDE_CODE_EXECPATH";

export interface ClaudeIsolationWiring {
  /** SDK 옵션으로 펼칠 격리 배선. off면 빈 객체다. */
  options(abortController: AbortController): {
    isolation?: RunnerIsolationChildConfig;
    onIsolationFailure?: (error: Error) => void;
  };
  /** 준비 실패로 중단된 턴의 오류. 없으면 undefined. */
  failure(): Error | undefined;
}

/**
 * 격리 준비 실패를 턴 오류로 고정하고 실행을 즉시 중단한다. 중단된 턴이
 * full 실행으로 흐르지 않도록 실패를 호출자가 읽을 수 있게 보관한다.
 */
export function claudeIsolationWiring(
  isolation: RunnerIsolationChildConfig | undefined,
): ClaudeIsolationWiring {
  let failure: Error | undefined;
  return {
    options: (abortController) => isolation
      ? {
          isolation,
          onIsolationFailure: (error: Error) => {
            failure = error;
            abortController.abort();
          },
        }
      : {},
    failure: () => failure,
  };
}

interface BuildClaudeSdkOptionsParams {
  options: ClaudeRunOptions;
  abortController: AbortController;
  output: EventQueue<ClaudeClientEvent>;
  logger: Logger;
  resolveClaudeExecutablePath: () => string | undefined;
  eventMapper: ClaudeSdkEventMapper;
  runtimeState: ClaudeRuntimeState;
  toolPermissionController: ClaudeSdkToolPermissionController;
  onChildProcessClosed?: (closed: Promise<void>) => void;
}

export function buildClaudeSdkOptions({
  options,
  abortController,
  output,
  logger,
  resolveClaudeExecutablePath,
  eventMapper,
  runtimeState,
  toolPermissionController,
  onChildProcessClosed,
}: BuildClaudeSdkOptionsParams): ClaudeSdkOptions {
  const executablePath =
    options.env?.[CLAUDE_CODE_EXECPATH_ENV]?.trim()
    || resolveClaudeExecutablePath();
  const systemPrompt = options.systemPrompt
    ? makeCacheableSystemPrompt(options.systemPrompt)
    : undefined;
  const permissionMode = options.claudePermissionMode ?? "bypassPermissions";

  return {
    abortController,
    cwd: options.workspaceDir,
    spawnClaudeCodeProcess: (spawnOptions) => {
      const mcpConfig = externalizeClaudeMcpConfig(
        spawnOptions.args,
        options.isolation?.spec.sandboxDirectory ?? options.mcpConfigDirectory,
      );
      let child: SpawnedProcess;
      try {
        if (options.isolation) {
          const launch = launchIsolatedChild({
            isolation: options.isolation,
            command: spawnOptions.command,
            args: mcpConfig.args,
            cwd: spawnOptions.cwd,
            env: spawnOptions.env,
            stdio: "pipe",
            ...(spawnOptions.signal ? { signal: spawnOptions.signal } : {}),
            logger,
          });
          void launch.ready.catch((error: unknown) => {
            options.onIsolationFailure?.(isolationError(error));
          });
          child = launch.child;
        } else {
          child = spawnClaudeSessionEngine(
            { ...spawnOptions, args: mcpConfig.args },
            logger,
            options.trackChildExit ? onChildProcessClosed : undefined,
          );
        }
      } catch (error) {
        mcpConfig.cleanup();
        throw error;
      }
      child.once("exit", mcpConfig.cleanup);
      child.once("error", mcpConfig.cleanup);
      return child;
    },
    ...(options.env !== undefined ? { env: options.env } : {}),
    permissionMode,
    ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    settingSources: ["project"],
    ...(options.autoMemoryEnabled !== undefined
      ? { settings: { autoMemoryEnabled: options.autoMemoryEnabled } }
      : {}),
    promptSuggestions: true,
    includePartialMessages: false,
    toolConfig: { askUserQuestion: { previewFormat: "markdown" } },
    canUseTool: toolPermissionController.makeCanUseTool(output, options),
    hooks: buildClaudeSdkHooks({
      output,
      systemPrompt,
      eventMapper,
      runtimeState,
      logger,
    }),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(options.resumeSessionId ? { resume: options.resumeSessionId } : {}),
    ...(executablePath ? { pathToClaudeCodeExecutable: executablePath } : {}),
    ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
    ...(options.disallowedTools !== undefined ? { disallowedTools: options.disallowedTools } : {}),
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.sessionStore !== undefined ? { sessionStore: options.sessionStore } : {}),
    ...(options.sessionStoreFlush !== undefined
      ? { sessionStoreFlush: options.sessionStoreFlush }
      : {}),
    ...(options.loadTimeoutMs !== undefined ? { loadTimeoutMs: options.loadTimeoutMs } : {}),
    ...buildMcpOptions(options, logger),
  };
}
