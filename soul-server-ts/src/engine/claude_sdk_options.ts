import type { Options as ClaudeSdkOptions } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { ClaudeRunOptions } from "./claude_adapter.js";
import type { ClaudeClientEvent } from "./claude_event_mapper.js";
import type { EventQueue } from "./claude_sdk_event_queue.js";
import type { ClaudeSdkEventMapper } from "./claude_sdk_event_mapper.js";
import { buildClaudeSdkHooks } from "./claude_sdk_hooks.js";
import { buildMcpOptions } from "./claude_sdk_mcp_options.js";
import { makeCacheableSystemPrompt } from "./claude_sdk_prompt.js";
import type { ClaudeRuntimeState } from "./claude_sdk_runtime_state.js";
import type { ClaudeSdkToolPermissionController } from "./claude_sdk_tool_permissions.js";
import { spawnClaudeSessionEngine } from "./session_engine_oom_score.js";

const CLAUDE_CODE_EXECPATH_ENV = "CLAUDE_CODE_EXECPATH";

interface BuildClaudeSdkOptionsParams {
  options: ClaudeRunOptions;
  abortController: AbortController;
  output: EventQueue<ClaudeClientEvent>;
  logger: Logger;
  resolveClaudeExecutablePath: () => string | undefined;
  eventMapper: ClaudeSdkEventMapper;
  runtimeState: ClaudeRuntimeState;
  toolPermissionController: ClaudeSdkToolPermissionController;
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
    ...(process.platform === "linux"
      ? { spawnClaudeCodeProcess: (spawnOptions) => spawnClaudeSessionEngine(spawnOptions, logger) }
      : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    permissionMode,
    ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    settingSources: ["project"],
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
