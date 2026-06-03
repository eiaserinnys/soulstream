import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  query as defaultQuery,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  McpServerConfig,
  Options as ClaudeSdkOptions,
  Query as ClaudeSdkQuery,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { ClaudeClient, ClaudeRunOptions } from "./claude_adapter.js";
import type { ClaudeClientEvent } from "./claude_event_mapper.js";
import type {
  ClaudeBackgroundTaskControlResult,
  EngineUserInput,
} from "./protocol.js";
import { getImageAttachmentMediaType } from "../attachments/image_media.js";
import { SOULSTREAM_AGENT_SESSION_HEADER } from "../mcp/request_context.js";

const CLAUDE_CODE_EXECPATH_ENV = "CLAUDE_CODE_EXECPATH";
const DEFAULT_INPUT_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
const MCP_CONFIG_FILE = "mcp_config.json";
const MAX_COMPACT_RETRIES = 3;
const COMPACT_SYSTEM_REMINDER_HEADER = [
  "Conversation compaction just occurred.",
  "The following system instructions remain authoritative. Continue following them exactly.",
  "Use them as instructions only; do not quote this reminder to the user.",
].join(" ");
/**
 * Result 도착 후 SDK가 발행하는 `prompt_suggestion` 메시지를 받기 위한 short drain 시간.
 *
 * Python `soul-server/src/soul_server/claude/receive_loop.py:33 PROMPT_SUGGESTION_DRAIN_TIMEOUT`
 * 2초 정본 정합. SDK 0.2.x 타입 정의 (sdk.d.ts) 명시:
 * "prompt_suggestion arrives after the result message. Consumers must keep iterating the
 *  stream after result to receive it."
 *
 * 일반 terminal result의 drain phase는 *prompt_suggestion 전용* — 그 외 메시지는 logger.warn
 * 후 무시 (Python receive_loop.py:180-188 narrowing 정책 정합).
 *
 * 단, SDK가 명시적인 continuation 신호를 줄 때는 stream을 계속 읽는다:
 *   - compact retry: 빈 result 뒤 실제 `system/compact_boundary`가 도착한 경우
 *   - AskUserQuestion/tool_use 재개: `stop_reason="tool_use"` result 뒤 다음 SDK 메시지가 도착한 경우
 */
const DEFAULT_POST_RESULT_DRAIN_MS = 2_000;
const DEFAULT_CLAUDE_RUNTIME_DRAIN_MAX_MS = 6 * 60 * 60 * 1_000;
const INPUT_REQUEST_TIMEOUT = Symbol("input_request_timeout");
const INPUT_REQUEST_ABORTED = Symbol("input_request_aborted");
const DRAIN_TIMEOUT = Symbol("post_result_drain_timeout");
const SOULSTREAM_SCHEDULE_TOOLS = new Set([
  "ScheduleWakeup",
  "CronCreate",
  "CronList",
  "CronDelete",
]);
const GENERIC_HOOK_EVENTS = [
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "SessionEnd",
  "StopFailure",
  "PostCompact",
  "PermissionRequest",
  "PermissionDenied",
  "Setup",
  "TeammateIdle",
  "Elicitation",
  "ElicitationResult",
  "ConfigChange",
  "WorktreeCreate",
  "WorktreeRemove",
  "InstructionsLoaded",
  "CwdChanged",
  "FileChanged",
] as const;
const STRIPPED_HOOK_OUTPUT = "[stripped: persisted in tool_result]";
const GENERIC_HOOK_OUTPUT_FIELDS = new Set([
  "tool_response",
  "tool_responses",
  "tool_response_chunks",
]);

type ClaudeResultEvent = Extract<ClaudeClientEvent, { type: "result" }>;
type GenericHookEventName = (typeof GENERIC_HOOK_EVENTS)[number];
type PostResultContinuationKind = "compact_boundary" | "tool_use";
type ClaudeRuntimeSessionState = "idle" | "running" | "requires_action";
type ClaudeRuntimeTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "killed";

type ClaudeRuntimeTaskSnapshot = {
  status: ClaudeRuntimeTaskStatus;
};

const TERMINAL_CLAUDE_RUNTIME_TASK_STATUSES = new Set<ClaudeRuntimeTaskStatus>([
  "completed",
  "failed",
  "stopped",
  "killed",
]);

type DrainAfterResultOutcome =
  | { action: "finish"; events: ClaudeClientEvent[] }
  | {
      action: "continue";
      reason: PostResultContinuationKind;
      events: ClaudeClientEvent[];
    };

export type ClaudeSdkQueryParams = {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: ClaudeSdkOptions;
};

export type ClaudeSdkQueryFn = (params: ClaudeSdkQueryParams) => ClaudeSdkQuery;

export interface ClaudeSdkClientConfig {
  query?: ClaudeSdkQueryFn;
  inputRequestTimeoutMs?: number;
  /**
   * Result 메시지 도착 후 prompt_suggestion 1메시지를 기다리는 best-effort drain timeout.
   * 기본 2초 — Python `PROMPT_SUGGESTION_DRAIN_TIMEOUT` 정합. 테스트에서 가속용으로만 override.
   */
  postResultDrainMs?: number;
  /**
   * Result 이후 Claude runtime task/session이 idle로 settle되길 기다리는 안전 상한.
   * ScheduleWakeup 같은 장기 실행을 허용하되 프로세스가 영원히 붙잡히지는 않게 한다.
   */
  runtimeDrainMaxMs?: number;
  resolveClaudeExecutablePath?: () => string | undefined;
}

type PendingInputRequest = {
  resolve: (
    value: Record<string, unknown> | typeof INPUT_REQUEST_TIMEOUT | typeof INPUT_REQUEST_ABORTED,
  ) => void;
  timeout: NodeJS.Timeout;
};

type EventQueue<T> = AsyncIterableIterator<T> & {
  push(value: T): boolean;
  close(): void;
  fail(err: unknown): void;
};

export class ClaudeSdkClient implements ClaudeClient {
  private readonly queryFn: ClaudeSdkQueryFn;
  private readonly logger: Logger;
  private readonly inputRequestTimeoutMs: number;
  private readonly postResultDrainMs: number;
  private readonly runtimeDrainMaxMs: number;
  private readonly resolveClaudeExecutablePath: () => string | undefined;
  private readonly pendingInputRequests = new Map<string, PendingInputRequest>();
  private readonly toolNamesById = new Map<string, string>();
  private readonly emittedToolResultIds = new Set<string>();
  private readonly interceptedScheduleToolUseIds = new Set<string>();
  private readonly backgroundAgentToolUseIds = new Set<string>();
  private readonly backgroundAgentTaskIds = new Set<string>();
  private readonly emittedSubagentStartIds = new Set<string>();
  private readonly emittedSubagentStopIds = new Set<string>();
  private readonly pendingCompactHookTriggers: string[] = [];
  private compactHookEventCount = 0;
  private readonly pendingCanUseToolCalls = new Set<symbol>();
  private readonly runtimeTasksById = new Map<string, ClaudeRuntimeTaskSnapshot>();
  private runtimeSessionState: ClaudeRuntimeSessionState | undefined;
  private toolUseTurnOpen = false;
  private toolUseTurnNeedsSafeDrain = false;

  private activeQuery: ClaudeSdkQuery | null = null;
  private activeInput: PushAsyncIterable<SDKUserMessage> | null = null;
  private activeSafeInterventionDrain: ClaudeRunOptions["onSafeInterventionDrain"];
  private lastWorkspaceDir: string | null = null;
  private lastEnv: Record<string, string> | undefined;

  constructor(config: ClaudeSdkClientConfig = {}, logger: Logger) {
    this.queryFn = config.query ?? defaultQuery;
    this.logger = logger;
    this.inputRequestTimeoutMs =
      config.inputRequestTimeoutMs ?? DEFAULT_INPUT_REQUEST_TIMEOUT_MS;
    this.postResultDrainMs =
      config.postResultDrainMs ?? DEFAULT_POST_RESULT_DRAIN_MS;
    this.runtimeDrainMaxMs =
      config.runtimeDrainMaxMs ?? DEFAULT_CLAUDE_RUNTIME_DRAIN_MAX_MS;
    this.resolveClaudeExecutablePath =
      config.resolveClaudeExecutablePath ?? resolveClaudeExecutableFromPath;
  }

  async *run(options: ClaudeRunOptions, signal: AbortSignal): AsyncIterable<ClaudeClientEvent> {
    this.lastWorkspaceDir = options.workspaceDir;
    this.lastEnv = options.env;
    this.clearPerRunState();

    const output = createEventQueue<ClaudeClientEvent>();
    const input = new PushAsyncIterable<SDKUserMessage>();
    input.push(makeUserMessage(options.prompt, options.imageAttachmentPaths));
    this.activeInput = input;
    this.activeSafeInterventionDrain = options.onSafeInterventionDrain;

    const abortController = new AbortController();
    const abortSdk = () => abortController.abort(signal.reason);
    if (signal.aborted) {
      abortSdk();
    } else {
      signal.addEventListener("abort", abortSdk, { once: true });
    }

    const queryOptions = this.buildSdkOptions(options, abortController, output);
    let query: ClaudeSdkQuery;
    try {
      query = this.queryFn({ prompt: input, options: queryOptions });
    } catch (err) {
      signal.removeEventListener("abort", abortSdk);
      input.close();
      if (this.activeInput === input) this.activeInput = null;
      this.activeSafeInterventionDrain = undefined;
      throw this.normalizeExecutionError(err, queryOptions.pathToClaudeCodeExecutable);
    }
    this.activeQuery = query;
    const pump = this.pumpQuery(query, output, abortController.signal);

    try {
      for await (const event of output) {
        yield event;
      }
      await pump;
    } catch (err) {
      throw this.normalizeExecutionError(err, queryOptions.pathToClaudeCodeExecutable);
    } finally {
      signal.removeEventListener("abort", abortSdk);
      input.close();
      if (this.activeInput === input) this.activeInput = null;
      if (this.activeQuery === query) this.activeQuery = null;
      this.activeSafeInterventionDrain = undefined;
      this.abortPendingInputRequests();
      await pump.catch(() => undefined);
    }
  }

  async compact(sessionId: string): Promise<void> {
    if (!this.lastWorkspaceDir) {
      throw new Error("ClaudeSdkClient.compact requires a previous run context");
    }

    const controller = new AbortController();
    const input = new PushAsyncIterable<SDKUserMessage>();
    input.push(makeUserMessage("/compact"));
    input.close();
    const output = createEventQueue<ClaudeClientEvent>();
    const queryOptions = this.buildSdkOptions(
      {
        prompt: "/compact",
        workspaceDir: this.lastWorkspaceDir,
        resumeSessionId: sessionId,
        ...(this.lastEnv !== undefined ? { env: this.lastEnv } : {}),
      },
      controller,
      output,
    );
    let query: ClaudeSdkQuery;
    try {
      query = this.queryFn({ prompt: input, options: queryOptions });
    } catch (err) {
      input.close();
      throw this.normalizeExecutionError(err, queryOptions.pathToClaudeCodeExecutable);
    }
    this.activeQuery = query;

    try {
      for await (const _ of query) {
        // Compact is a control action; callers only need completion/failure.
      }
    } catch (err) {
      throw this.normalizeExecutionError(err, queryOptions.pathToClaudeCodeExecutable);
    } finally {
      input.close();
      if (this.activeQuery === query) this.activeQuery = null;
    }
  }

  deliverInputResponse(requestId: string, answers: Record<string, unknown>): boolean {
    const pending = this.pendingInputRequests.get(requestId);
    if (!pending) return false;
    pending.resolve(answers);
    return true;
  }

  steerActiveTurn(input: EngineUserInput): boolean {
    const activeInput = this.activeInput;
    if (!activeInput) return false;
    if (!this.canAcceptLiveUserInput()) return false;
    return activeInput.push(makeUserMessage(input.prompt, input.imageAttachmentPaths));
  }

  async backgroundClaudeRuntimeTasks(
    toolUseId?: string,
  ): Promise<ClaudeBackgroundTaskControlResult> {
    const query = this.activeQuery;
    if (!query) {
      return {
        status: "no_active_query",
        message: "No active Claude SDK query",
      };
    }
    try {
      const backgrounded = await query.backgroundTasks(toolUseId);
      if (!backgrounded) {
        return {
          status: "no_match",
          message: toolUseId
            ? `No foreground Claude task matched toolUseId: ${toolUseId}`
            : "No foreground Claude task was backgrounded",
        };
      }
      return { status: "ok" };
    } catch (err) {
      return {
        status: "failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async stopClaudeRuntimeTask(taskId: string): Promise<ClaudeBackgroundTaskControlResult> {
    const query = this.activeQuery;
    if (!query) {
      return {
        status: "no_active_query",
        message: "No active Claude SDK query",
      };
    }
    try {
      await query.stopTask(taskId);
      return { status: "ok" };
    } catch (err) {
      return {
        status: "failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async interrupt(): Promise<boolean> {
    const query = this.activeQuery;
    if (!query) return false;
    try {
      await query.interrupt();
    } catch (err) {
      this.logger.warn({ err }, "Claude SDK interrupt failed; closing query");
      query.close();
    }
    this.abortPendingInputRequests();
    return true;
  }

  async close(): Promise<void> {
    this.activeInput?.close();
    this.activeQuery?.close();
    this.abortPendingInputRequests();
  }

  private buildSdkOptions(
    options: ClaudeRunOptions,
    abortController: AbortController,
    output: EventQueue<ClaudeClientEvent>,
  ): ClaudeSdkOptions {
    const executablePath =
      options.env?.[CLAUDE_CODE_EXECPATH_ENV]?.trim()
      || this.resolveClaudeExecutablePath();
    const systemPrompt = options.systemPrompt
      ? makeCacheableSystemPrompt(options.systemPrompt)
      : undefined;
    const permissionMode = options.claudePermissionMode ?? "bypassPermissions";

    return {
      abortController,
      cwd: options.workspaceDir,
      ...(options.env !== undefined ? { env: options.env } : {}),
      permissionMode,
      ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      settingSources: ["project"],
      promptSuggestions: true,
      includePartialMessages: false,
      toolConfig: { askUserQuestion: { previewFormat: "markdown" } },
      canUseTool: this.makeCanUseTool(output, options),
      hooks: this.buildHooks(output, systemPrompt),
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
      ...buildMcpOptions(options, this.logger),
    };
  }

  private makeCanUseTool(
    output: EventQueue<ClaudeClientEvent>,
    options: ClaudeRunOptions,
  ): CanUseTool {
    return async (toolName, input, context) => {
      const pendingToolCall = Symbol(toolName);
      this.pendingCanUseToolCalls.add(pendingToolCall);
      try {
        if (toolName === "PushNotification") {
          output.push(this.makeNotificationEventFromToolUse(input, context.toolUseID));
          this.interceptedScheduleToolUseIds.add(context.toolUseID);
          return {
            behavior: "deny",
            message:
              "Soulstream in-app notification captured. External APNs/Expo push is not configured for this runtime.",
            toolUseID: context.toolUseID,
          };
        }

        if (toolName === "RemoteTrigger") {
          output.push(this.makeRemoteTriggerEventFromToolUse(input, context.toolUseID));
          this.interceptedScheduleToolUseIds.add(context.toolUseID);
          return {
            behavior: "deny",
            message:
              "Soulstream intervention/capability routing is already the remote trigger path for this session.",
            toolUseID: context.toolUseID,
          };
        }

        if (SOULSTREAM_SCHEDULE_TOOLS.has(toolName)) {
          if (!options.onScheduleToolUse || !options.agentSessionId) {
            return {
              behavior: "deny",
              message: "Soulstream durable scheduler is not configured for this turn.",
              toolUseID: context.toolUseID,
            };
          }
          try {
            const result = await options.onScheduleToolUse({
              agentSessionId: options.agentSessionId,
              toolUseId: context.toolUseID,
              toolName,
              input: asRecord(input) ?? {},
              now: new Date(),
            });
            this.interceptedScheduleToolUseIds.add(context.toolUseID);
            return {
              behavior: "deny",
              message: result.message,
              toolUseID: context.toolUseID,
            };
          } catch (err) {
            return {
              behavior: "deny",
              message: err instanceof Error ? err.message : String(err),
              toolUseID: context.toolUseID,
            };
          }
        }

        if (toolName !== "AskUserQuestion") {
          return { behavior: "allow", toolUseID: context.toolUseID };
        }

        const requestId = randomUUID().replaceAll("-", "").slice(0, 12);
        const startedAt = Date.now() / 1000;
        const questions = Array.isArray(input.questions) ? input.questions : [];
        output.push({
          type: "input_request",
          requestId,
          toolUseId: context.toolUseID,
          questions,
          startedAt,
          timeoutSec: this.inputRequestTimeoutMs / 1000,
        });

        const response = await this.waitForInputResponse(requestId, context.signal);
        if (response === INPUT_REQUEST_TIMEOUT) {
          output.push({ type: "input_request_expired", requestId });
          return {
            behavior: "deny",
            message: "사용자 응답 대기 시간이 초과되었습니다.",
            toolUseID: context.toolUseID,
          };
        }
        if (response === INPUT_REQUEST_ABORTED) {
          return {
            behavior: "deny",
            message: "사용자 응답 대기가 중단되었습니다.",
            interrupt: true,
            toolUseID: context.toolUseID,
          };
        }

        return {
          behavior: "allow",
          updatedInput: { ...input, answers: response },
          toolUseID: context.toolUseID,
        };
      } finally {
        this.pendingCanUseToolCalls.delete(pendingToolCall);
        await this.drainSafeInterventions();
      }
    };
  }

  private makeNotificationEventFromToolUse(
    input: Record<string, unknown>,
    toolUseId: string,
  ): ClaudeClientEvent {
    const title = asString(input.title) ?? asString(input.subject);
    const message =
      asString(input.message) ??
      asString(input.body) ??
      asString(input.text) ??
      title ??
      "Claude requested a notification";
    return {
      type: "claude_runtime_notification",
      notificationId: toolUseId,
      source: "tool_use",
      toolUseId,
      message,
      ...(title !== undefined ? { title } : {}),
      ...(asString(input.notification_type) !== undefined
        ? { notificationType: asString(input.notification_type) }
        : {}),
      ...(asString(input.key) !== undefined ? { key: asString(input.key) } : {}),
      ...(asString(input.priority) !== undefined ? { priority: asString(input.priority) } : {}),
    };
  }

  private makeRemoteTriggerEventFromToolUse(
    input: Record<string, unknown>,
    toolUseId: string,
  ): ClaudeClientEvent {
    const prompt = asString(input.prompt) ?? asString(input.message) ?? asString(input.text);
    return {
      type: "claude_runtime_remote_trigger",
      triggerId: toolUseId,
      source: "tool_use",
      toolUseId,
      ...(asString(input.trigger) !== undefined ? { triggerType: asString(input.trigger) } : {}),
      ...(asString(input.type) !== undefined && asString(input.trigger) === undefined
        ? { triggerType: asString(input.type) }
        : {}),
      ...(prompt !== undefined ? { prompt } : {}),
      payload: { ...input },
    };
  }

  private buildHooks(
    output: EventQueue<ClaudeClientEvent>,
    systemPrompt: string[] | undefined,
  ): NonNullable<ClaudeSdkOptions["hooks"]> {
    const compactSystemReminder = makeCompactSystemReminder(systemPrompt);
    const hooks: NonNullable<ClaudeSdkOptions["hooks"]> = {
      PreToolUse: [
        {
          matcher: "Agent",
          hooks: [
            async (input) => {
              const record = asRecord(input);
              this.rememberBackgroundAgentToolUse(
                asString(record?.tool_use_id),
                asRecord(record?.tool_input),
              );
              return {};
            },
          ],
        },
      ],
      PreCompact: [
        {
          hooks: [
            async (input) => {
              const trigger = asString(asRecord(input)?.trigger) ?? "auto";
              this.compactHookEventCount += 1;
              this.pendingCompactHookTriggers.push(trigger);
              output.push({
                type: "compact",
                trigger,
                message: compactMessage(trigger),
              });
              return {};
            },
          ],
        },
      ],
      SubagentStart: [
        {
          hooks: [
            async (input) => {
              const record = asRecord(input);
              for (const event of this.makeSubagentStartEvents(
                asString(record?.agent_id),
                asString(record?.agent_type),
              )) {
                output.push(event);
              }
              return {};
            },
          ],
        },
      ],
      SubagentStop: [
        {
          hooks: [
            async (input) => {
              const record = asRecord(input);
              for (const event of this.makeSubagentStopEvents(asString(record?.agent_id))) {
                output.push(event);
              }
              return {};
            },
          ],
        },
      ],
      TaskCreated: [
        {
          hooks: [
            async (input) => {
              const record = asRecord(input);
              const taskId = asString(record?.task_id);
              const subject = asString(record?.task_subject);
              if (!taskId || !subject) return {};
              this.runtimeTasksById.set(taskId, { status: "pending" });
              output.push({
                type: "claude_runtime_task_created",
                taskId,
                subject,
                ...(asString(record?.session_id) !== undefined
                  ? { sessionId: asString(record?.session_id) }
                  : {}),
                ...(asString(record?.task_description) !== undefined
                  ? { description: asString(record?.task_description) }
                  : {}),
                ...(asString(record?.teammate_name) !== undefined
                  ? { teammateName: asString(record?.teammate_name) }
                  : {}),
                ...(asString(record?.team_name) !== undefined
                  ? { teamName: asString(record?.team_name) }
                  : {}),
              });
              return {};
            },
          ],
        },
      ],
      TaskCompleted: [
        {
          hooks: [
            async (input) => {
              const record = asRecord(input);
              const taskId = asString(record?.task_id);
              const subject = asString(record?.task_subject);
              if (!taskId || !subject) return {};
              this.runtimeTasksById.set(taskId, { status: "completed" });
              output.push({
                type: "claude_runtime_task_completed",
                taskId,
                subject,
                ...(asString(record?.session_id) !== undefined
                  ? { sessionId: asString(record?.session_id) }
                  : {}),
                ...(asString(record?.task_description) !== undefined
                  ? { description: asString(record?.task_description) }
                  : {}),
                ...(asString(record?.teammate_name) !== undefined
                  ? { teammateName: asString(record?.teammate_name) }
                  : {}),
                ...(asString(record?.team_name) !== undefined
                  ? { teamName: asString(record?.team_name) }
                  : {}),
              });
              return {};
            },
          ],
        },
      ],
      Notification: [
        {
          hooks: [
            async (input) => {
              const record = asRecord(input);
              const title = asString(record?.title) ?? "";
              const message = asString(record?.message) ?? "";
              const notificationType = asString(record?.notification_type) ?? "";
              output.push({
                type: "debug",
                message: `[${notificationType}] ${title}: ${message}`,
              });
              if (message || title) {
                output.push({
                  type: "claude_runtime_notification",
                  notificationId: asString(record?.uuid) ?? randomUUID(),
                  source: "hook",
                  message: message || title,
                  ...(title ? { title } : {}),
                  ...(notificationType ? { notificationType } : {}),
                  ...(asString(record?.session_id) !== undefined
                    ? { sessionId: asString(record?.session_id) }
                    : {}),
                });
              }
              return {};
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            async (input) => {
              const record = asRecord(input);
              this.logger.info(
                {
                  stopHookActive: record?.stop_hook_active,
                  hasLastAssistantMessage: typeof record?.last_assistant_message === "string",
                },
                "Claude Stop hook fired",
              );
              return {};
            },
          ],
        },
      ],
    };
    for (const hookEventName of GENERIC_HOOK_EVENTS) {
      hooks[hookEventName] = [
        {
          hooks: [
            async (input, toolUseID) => {
              for (const event of this.makeGenericHookEvents(hookEventName, input, toolUseID)) {
                output.push(event);
              }
              return {};
            },
          ],
        },
      ];
    }
    if (compactSystemReminder) {
      hooks.SessionStart = [
        {
          matcher: "compact",
          hooks: [
            async (input) => {
              const record = asRecord(input);
              if (asString(record?.source) !== "compact") {
                return {};
              }
              return {
                hookSpecificOutput: {
                  hookEventName: "SessionStart",
                  additionalContext: compactSystemReminder,
                },
              };
            },
          ],
        },
      ];
    }
    return hooks;
  }

  private makeGenericHookEvents(
    hookEventName: GenericHookEventName,
    input: unknown,
    toolUseID: string | undefined,
  ): ClaudeClientEvent[] {
    const record = asRecord(input) ?? {};
    const toolUseId = asString(record.tool_use_id) ?? toolUseID;
    const event: ClaudeClientEvent = {
      type: "claude_runtime_hook_event",
      hookEventName,
      ...(asString(record.session_id) !== undefined
        ? { sessionId: asString(record.session_id) }
        : {}),
      ...(asString(record.tool_name) !== undefined ? { toolName: asString(record.tool_name) } : {}),
      ...(toolUseId !== undefined ? { toolUseId } : {}),
      hookInput: stripGenericHookOutputFields(record),
    };
    const events: ClaudeClientEvent[] = [event];
    if (hookEventName === "WorktreeCreate") {
      events.push({
        type: "claude_runtime_mode_state",
        mode: "worktree",
        active: true,
        source: "hook",
        ...(asString(record.session_id) !== undefined
          ? { sessionId: asString(record.session_id) }
          : {}),
        ...(asString(record.name) !== undefined ? { worktreeName: asString(record.name) } : {}),
      });
    } else if (hookEventName === "WorktreeRemove") {
      events.push({
        type: "claude_runtime_mode_state",
        mode: "worktree",
        active: false,
        source: "hook",
        ...(asString(record.session_id) !== undefined
          ? { sessionId: asString(record.session_id) }
          : {}),
        ...(asString(record.worktree_path) !== undefined
          ? { worktreePath: asString(record.worktree_path) }
          : {}),
      });
    }
    return events;
  }

  private makeModeEventsFromToolUse(
    toolName: string,
    toolUseId: string | null,
    toolInput: Record<string, unknown>,
  ): ClaudeClientEvent[] {
    if (toolName === "EnterPlanMode") {
      return [
        {
          type: "claude_runtime_mode_state",
          mode: "plan",
          active: true,
          source: "tool_use",
          toolName,
          ...(toolUseId !== null ? { toolUseId } : {}),
        },
      ];
    }
    if (toolName === "ExitPlanMode") {
      return [
        {
          type: "claude_runtime_mode_state",
          mode: "plan",
          active: false,
          source: "tool_use",
          toolName,
          ...(toolUseId !== null ? { toolUseId } : {}),
        },
      ];
    }
    if (toolName === "EnterWorktree") {
      return [
        {
          type: "claude_runtime_mode_state",
          mode: "worktree",
          active: true,
          source: "tool_use",
          toolName,
          ...(toolUseId !== null ? { toolUseId } : {}),
          ...(asString(toolInput.name) !== undefined
            ? { worktreeName: asString(toolInput.name) }
            : {}),
          ...(asString(toolInput.path) !== undefined
            ? { worktreePath: asString(toolInput.path) }
            : {}),
        },
      ];
    }
    if (toolName === "ExitWorktree") {
      return [
        {
          type: "claude_runtime_mode_state",
          mode: "worktree",
          active: false,
          source: "tool_use",
          toolName,
          ...(toolUseId !== null ? { toolUseId } : {}),
          ...(asString(toolInput.action) !== undefined
            ? { worktreeAction: asString(toolInput.action) }
            : {}),
        },
      ];
    }
    return [];
  }

  private waitForInputResponse(
    requestId: string,
    signal: AbortSignal,
  ): Promise<
    Record<string, unknown> | typeof INPUT_REQUEST_TIMEOUT | typeof INPUT_REQUEST_ABORTED
  > {
    return new Promise((resolve) => {
      let timeout: NodeJS.Timeout;
      const settle = (
        value:
          | Record<string, unknown>
          | typeof INPUT_REQUEST_TIMEOUT
          | typeof INPUT_REQUEST_ABORTED,
      ) => {
        signal.removeEventListener("abort", abort);
        clearTimeout(timeout);
        this.pendingInputRequests.delete(requestId);
        resolve(value);
      };
      const abort = () => settle(INPUT_REQUEST_ABORTED);
      timeout = setTimeout(() => settle(INPUT_REQUEST_TIMEOUT), this.inputRequestTimeoutMs);
      if (signal.aborted) {
        settle(INPUT_REQUEST_ABORTED);
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      this.pendingInputRequests.set(requestId, {
        resolve: settle,
        timeout,
      });
    });
  }

  private async pumpQuery(
    query: ClaudeSdkQuery,
    output: EventQueue<ClaudeClientEvent>,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      let compactRetryCount = 0;
      for (;;) {
        const queryIter = query[Symbol.asyncIterator]();
        const compactSnapshot = this.compactHookEventCount;
        let sawResult = false;
        for (;;) {
          const next = await queryIter.next();
          if (next.done) {
            if (
              this.shouldRetryAfterCompactNoResult({
                compactSnapshot,
                compactRetryCount,
                query,
                signal,
                sawResult,
              })
            ) {
              compactRetryCount += 1;
              break;
            }
            if (this.hasPendingRuntimeWork()) {
              output.push({
                type: "error",
                fatal: true,
                errorCode: "claude_runtime_ended_before_idle",
                message: "Claude SDK stream ended while runtime work was still pending.",
              });
            }
            output.close();
            return;
          }
          const message = next.value;

          const msg = asRecord(message);
          if (msg?.type === "result") {
            sawResult = true;
            const terminalEvents = this.mapResultMessage(msg);
            const resultEvent = terminalEvents.find((event) => event.type === "result");
            this.noteResultBoundary(resultEvent);
            const continuations =
              resultEvent?.type === "result"
                ? this.postResultContinuations(resultEvent, compactRetryCount)
                : new Set<PostResultContinuationKind>();

            const drain = await this.drainAfterResult(queryIter, continuations);

            if (drain.action === "continue") {
              if (drain.reason === "compact_boundary") compactRetryCount += 1;
              for (const event of drain.events) output.push(event);
              continue;
            }

            const drainedLiveIntervention =
              await this.drainSafeInterventionsAfterResultBoundary();
            this.pushTerminalEvents(output, terminalEvents, drain.events);
            if (drainedLiveIntervention) {
              continue;
            }
            query.close();
            output.close();
            return;
          }

          let shouldStop = false;
          for (const event of this.mapSdkMessage(message)) {
            output.push(event);
            if (event.type === "complete" || (event.type === "error" && event.fatal !== false)) {
              shouldStop = true;
            }
          }
          if (shouldStop) {
          // Result/complete (또는 fatal error) 도착 — post-result drain phase로 진입.
          // Python `receive_loop._drain_after_result` (L126-188) 정합:
          //   - prompt_suggestion 1메시지를 best-effort로 기다림 (default 2초)
          //   - 그 외 메시지(StreamEvent · stray assistant 등)는 narrowing → logger.warn 후 무시
          //   - timeout / EOS / 에러 모두 조용히 종료 (drain은 부가 기능, §8 실패 격리)
            const drain = await this.drainAfterResult(
              queryIter,
              new Set<PostResultContinuationKind>(),
            );
            for (const event of drain.events) output.push(event);
            query.close();
            output.close();
            return;
          }
        }
      }
    } catch (err) {
      output.fail(err);
      throw err;
    }
  }

  private postResultContinuations(
    resultEvent: ClaudeResultEvent,
    compactRetryCount: number,
  ): Set<PostResultContinuationKind> {
    const continuations = new Set<PostResultContinuationKind>();
    if (!resultEvent.success) return continuations;

    if (resultEvent.stopReason === "tool_use") {
      continuations.add("tool_use");
    }
    if (resultEvent.output.length === 0 && compactRetryCount < MAX_COMPACT_RETRIES) {
      continuations.add("compact_boundary");
    }
    return continuations;
  }

  /**
   * Result 이후 SDK가 보낼 수 있는 trailing/continuation/runtime 메시지를 drain한다.
   *
   * Python `receive_loop._drain_after_result` 정본은 prompt_suggestion만 처리한다.
   * TS SDK에서는 같은 위치에 compact_boundary와 tool_use 재개 메시지도 올 수 있으므로,
   * result의 SDK 신호로 허용된 continuation만 통과시키고 나머지는 terminal drain으로 좁힌다.
   *
   * runtime task/session이 pending이면 SDK `session_state_changed.idle` 또는 runtime task terminal
   * 상태까지 기다린다. 단, `runtimeDrainMaxMs`를 넘기면 query를 닫아 무한 대기를 차단한다.
   */
  private async drainAfterResult(
    queryIter: AsyncIterator<SDKMessage>,
    continuations: ReadonlySet<PostResultContinuationKind>,
  ): Promise<DrainAfterResultOutcome> {
    const startedAt = Date.now();
    const events: ClaudeClientEvent[] = [];

    for (;;) {
      const pendingRuntime = this.hasPendingRuntimeWork();
      const waitMs = pendingRuntime
        ? Math.max(0, this.runtimeDrainMaxMs - (Date.now() - startedAt))
        : this.postResultDrainMs;

      if (waitMs <= 0) {
        events.push(...this.makeRuntimeTimeoutEvents());
        return { action: "finish", events };
      }

      let settled: IteratorResult<SDKMessage> | typeof DRAIN_TIMEOUT;
      try {
        settled = await this.nextWithDrainTimeout(queryIter, waitMs);
      } catch (err) {
        events.push(this.makeDrainErrorEvent(err));
        return { action: "finish", events };
      }
      if (settled === DRAIN_TIMEOUT) {
        if (pendingRuntime) {
          events.push(...this.makeRuntimeTimeoutEvents());
        } else {
          this.logger.debug?.({ ms: this.postResultDrainMs }, "post-result drain timed out");
        }
        return { action: "finish", events };
      }
      if (settled.done) {
        return { action: "finish", events };
      }

      const msg = asRecord(settled.value);
      if (msg && msg.type === "prompt_suggestion") {
        events.push(...this.mapPromptSuggestion(msg));
        if (this.hasPendingRuntimeWork()) continue;
        return { action: "finish", events };
      }
      if (msg && isRuntimeSystemMessage(msg)) {
        events.push(...this.mapSystemMessage(msg));
        if (this.hasPendingRuntimeWork()) continue;
        return { action: "finish", events };
      }
      if (msg?.type === "system" && msg.subtype === "compact_boundary") {
        const mapped = this.mapSystemMessage(msg);
        events.push(...mapped);
        if (continuations.has("compact_boundary")) {
          return { action: "continue", reason: "compact_boundary", events };
        }
        if (this.hasPendingRuntimeWork()) continue;
        return { action: "finish", events };
      }
      if (continuations.has("tool_use")) {
        this.logger.debug?.(
          { messageType: msg?.type ?? "unknown" },
          "post-tool-use-result drain received continuation message",
        );
        if (msg?.type === "result") {
          const terminalEvents = this.mapResultMessage(msg);
          const resultEvent = terminalEvents.find((event) => event.type === "result");
          this.noteResultBoundary(resultEvent);
          const nextContinuations =
            resultEvent?.type === "result"
              ? this.postResultContinuations(resultEvent, 0)
              : new Set<PostResultContinuationKind>();
          const drain = await this.drainAfterResult(queryIter, nextContinuations);
          if (drain.action === "continue") {
            events.push(...drain.events);
            return { action: "continue", reason: drain.reason, events };
          }
          await this.drainSafeInterventionsAfterResultBoundary();
          events.push(...this.orderTerminalEvents(terminalEvents, drain.events));
          return { action: "continue", reason: "tool_use", events };
        }
        const mapped = this.mapSdkMessage(settled.value);
        events.push(...mapped);
        return { action: "continue", reason: "tool_use", events };
      }
      // Runtime이 이미 pending이면 stray 메시지 하나 때문에 query를 닫지 않는다.
      this.logger.warn?.(
        { messageType: msg?.type ?? "unknown" },
        "post-result drain received unexpected message type — ignoring",
      );
      if (this.hasPendingRuntimeWork()) continue;
      return { action: "finish", events };
    }
  }

  private async nextWithDrainTimeout(
    queryIter: AsyncIterator<SDKMessage>,
    waitMs: number,
  ): Promise<IteratorResult<SDKMessage> | typeof DRAIN_TIMEOUT> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<typeof DRAIN_TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(DRAIN_TIMEOUT), waitMs);
    });
    const nextPromise = queryIter.next();
    try {
      return await Promise.race([nextPromise, timeoutPromise]);
    } catch (err) {
      this.logger.debug?.({ err }, "post-result drain errored");
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private makeDrainErrorEvent(err: unknown): ClaudeClientEvent {
    return {
      type: "error",
      fatal: true,
      errorCode: "claude_sdk_drain_error",
      message: `Claude SDK post-result drain failed: ${errorMessage(err)}`,
    };
  }

  private pushTerminalEvents(
    output: EventQueue<ClaudeClientEvent>,
    terminalEvents: ClaudeClientEvent[],
    drainEvents: ClaudeClientEvent[],
  ): void {
    for (const event of this.orderTerminalEvents(terminalEvents, drainEvents)) {
      output.push(event);
    }
  }

  private orderTerminalEvents(
    terminalEvents: ClaudeClientEvent[],
    drainEvents: ClaudeClientEvent[],
  ): ClaudeClientEvent[] {
    if (drainEvents.some(isFatalClientError)) {
      return drainEvents;
    }
    if (this.hasPendingRuntimeWork() || drainEvents.some(isRuntimeClientEvent)) {
      return [...drainEvents, ...terminalEvents];
    }
    return [...terminalEvents, ...drainEvents];
  }

  private makeRuntimeTimeoutEvents(): ClaudeClientEvent[] {
    const message = `Claude runtime drain timed out after ${this.runtimeDrainMaxMs}ms; closing query.`;
    const events: ClaudeClientEvent[] = [
      {
        type: "debug",
        message,
      },
    ];

    for (const [taskId, runtimeTask] of this.runtimeTasksById.entries()) {
      if (TERMINAL_CLAUDE_RUNTIME_TASK_STATUSES.has(runtimeTask.status)) continue;
      this.runtimeTasksById.set(taskId, { status: "failed" });
      events.push({
        type: "claude_runtime_task_notification",
        taskId,
        status: "failed",
        summary: message,
      });
    }

    if (this.runtimeSessionState && this.runtimeSessionState !== "idle") {
      this.runtimeSessionState = "idle";
      events.push({
        type: "claude_runtime_session_state",
        state: "idle",
      });
    }

    events.push({
      type: "error",
      fatal: true,
      errorCode: "claude_runtime_timeout",
      message,
    });
    return events;
  }

  private mapSdkMessage(message: SDKMessage): ClaudeClientEvent[] {
    const msg = asRecord(message);
    if (!msg) return [];

    switch (msg.type) {
      case "system":
        return this.mapSystemMessage(msg);
      case "assistant":
        return this.mapAssistantMessage(msg);
      case "user":
        return this.mapUserMessage(msg);
      case "result":
        return this.mapResultMessage(msg);
      case "prompt_suggestion":
        return this.mapPromptSuggestion(msg);
      case "rate_limit_event":
        return this.mapRateLimit(msg);
      default:
        return [];
    }
  }

  private mapSystemMessage(message: Record<string, unknown>): ClaudeClientEvent[] {
    const subtype = asString(message.subtype);
    if (subtype === "init") {
      const sessionId = asString(message.session_id);
      return sessionId ? [{ type: "session", sessionId }] : [];
    }
    if (subtype === "session_state_changed") {
      const state = parseRuntimeSessionState(message.state);
      if (!state) return [];
      this.runtimeSessionState = state;
      return [
        {
          type: "claude_runtime_session_state",
          state,
          ...(asString(message.session_id) !== undefined
            ? { sessionId: asString(message.session_id) }
            : {}),
        },
      ];
    }
    if (subtype === "away_summary") {
      // Python `message_processor._handle_system_message` L113-120 정합:
      // SystemMessage(subtype="away_summary", data={content: ...}) → AwaySummaryEngineEvent
      const data = asRecord(message.data);
      const content = asString(data?.content);
      return content ? [{ type: "away_summary", content }] : [];
    }
    if (subtype === "compact_boundary") {
      const metadata = asRecord(message.compact_metadata);
      const trigger = asString(metadata?.trigger) ?? "unknown";
      if (this.consumePendingCompactHookTrigger(trigger)) return [];
      return [
        {
          type: "compact",
          trigger,
          message: compactMessage(trigger),
        },
      ];
    }
    if (subtype === "task_started") {
      const taskId = asString(message.task_id);
      if (!taskId) return [];
      this.runtimeTasksById.set(taskId, { status: "running" });
      const toolUseId = asString(message.tool_use_id);
      const isBackgroundAgent = toolUseId
        ? this.backgroundAgentToolUseIds.has(toolUseId)
        : false;
      if (isBackgroundAgent) this.backgroundAgentTaskIds.add(taskId);
      const taskType = asString(message.task_type) ?? (isBackgroundAgent ? "agent" : undefined);
      const runtimeEvents: ClaudeClientEvent[] = [
        {
          type: "claude_runtime_task_started",
          taskId,
          ...(asString(message.session_id) !== undefined
            ? { sessionId: asString(message.session_id) }
            : {}),
          ...(toolUseId !== undefined
            ? { toolUseId }
            : {}),
          ...(asString(message.description) !== undefined
            ? { description: asString(message.description) }
            : {}),
          ...(taskType !== undefined
            ? { taskType }
            : {}),
          ...(asString(message.workflow_name) !== undefined
            ? { workflowName: asString(message.workflow_name) }
            : {}),
          ...(asString(message.prompt) !== undefined ? { prompt: asString(message.prompt) } : {}),
          ...(typeof message.skip_transcript === "boolean"
            ? { skipTranscript: message.skip_transcript }
            : {}),
        },
      ];
      if (isBackgroundAgent) {
        runtimeEvents.push({
          type: "claude_runtime_task_updated",
          taskId,
          ...(asString(message.session_id) !== undefined
            ? { sessionId: asString(message.session_id) }
            : {}),
          patch: {
            status: "running",
            is_backgrounded: true,
            task_type: taskType,
            ...(toolUseId !== undefined ? { tool_use_id: toolUseId } : {}),
          },
        });
      }
      return [
        ...(isBackgroundAgent ? [] : this.makeSubagentStartEvents(taskId, taskType)),
        ...runtimeEvents,
      ];
    }
    if (subtype === "task_notification") {
      const taskId = asString(message.task_id);
      const status = parseRuntimeNotificationStatus(message.status);
      if (!taskId || !status) return [];
      this.runtimeTasksById.set(taskId, { status });
      const isBackgroundAgent = this.backgroundAgentTaskIds.has(taskId);
      return [
        ...(isBackgroundAgent ? [] : this.makeSubagentStopEvents(taskId)),
        {
          type: "claude_runtime_task_notification",
          taskId,
          status,
          ...(asString(message.session_id) !== undefined
            ? { sessionId: asString(message.session_id) }
            : {}),
          ...(asString(message.tool_use_id) !== undefined
            ? { toolUseId: asString(message.tool_use_id) }
            : {}),
          ...(asString(message.output_file) !== undefined
            ? { outputFile: asString(message.output_file) }
            : {}),
          ...(asString(message.summary) !== undefined
            ? { summary: asString(message.summary) }
            : {}),
          ...(message.usage !== undefined ? { usage: message.usage } : {}),
          ...(typeof message.skip_transcript === "boolean"
            ? { skipTranscript: message.skip_transcript }
            : {}),
        },
      ];
    }
    if (subtype === "task_updated") {
      const taskId = asString(message.task_id);
      const patch = asRecord(message.patch) ?? {};
      if (!taskId) return [];
      const status = parseRuntimeTaskStatus(patch.status);
      const existing = this.runtimeTasksById.get(taskId);
      this.runtimeTasksById.set(taskId, {
        status: status ?? existing?.status ?? "pending",
      });
      return [
        {
          type: "claude_runtime_task_updated",
          taskId,
          patch,
          ...(asString(message.session_id) !== undefined
            ? { sessionId: asString(message.session_id) }
            : {}),
        },
      ];
    }
    if (subtype === "notification") {
      const text = asString(message.text) ?? "";
      const key = asString(message.key);
      const priority = asString(message.priority);
      const prefix = [priority, key].filter(Boolean).join(":");
      const notificationId = asString(message.uuid) ?? key ?? randomUUID();
      const runtimeEvent: ClaudeClientEvent | null = text
        ? {
            type: "claude_runtime_notification",
            notificationId,
            source: "system",
            message: text,
            ...(key !== undefined ? { key } : {}),
            ...(priority !== undefined ? { priority } : {}),
            ...(asString(message.session_id) !== undefined
              ? { sessionId: asString(message.session_id) }
              : {}),
          }
        : null;
      return text
        ? [
            { type: "debug", message: prefix ? `[${prefix}] ${text}` : text },
            ...(runtimeEvent ? [runtimeEvent] : []),
          ]
        : [];
    }
    if (subtype === "mirror_error") {
      const key = asRecord(message.key);
      const projectKey = asString(key?.projectKey);
      const transcriptSessionId = asString(key?.sessionId);
      const error = asString(message.error);
      if (!projectKey || !transcriptSessionId || !error) return [];
      return [
        {
          type: "claude_runtime_transcript_mirror_error",
          mirrorId: asString(message.uuid) ?? randomUUID(),
          ...(asString(message.session_id) !== undefined
            ? { sessionId: asString(message.session_id) }
            : {}),
          projectKey,
          transcriptSessionId,
          ...(asString(key?.subpath) !== undefined ? { subpath: asString(key?.subpath) } : {}),
          error,
        },
      ];
    }
    if (subtype === "permission_denied") {
      const toolName = asString(message.tool_name) ?? "tool";
      const toolUseId = asString(message.tool_use_id);
      const detail = asString(message.message) ?? "permission denied";
      if (
        (toolUseId && this.interceptedScheduleToolUseIds.has(toolUseId))
        || (SOULSTREAM_SCHEDULE_TOOLS.has(toolName)
          && detail.includes("Soulstream durable scheduler"))
      ) {
        return [];
      }
      return [
        {
          type: "error",
          fatal: false,
          errorCode: "permission_denied",
          message: `${toolName}: ${detail}`,
        },
      ];
    }
    if (subtype === "task_progress") {
      const taskId = asString(message.task_id);
      if (taskId) this.runtimeTasksById.set(taskId, { status: "running" });
      const summary = asString(message.summary);
      const description = asString(message.description);
      const text = summary ?? description;
      const events: ClaudeClientEvent[] = text ? [{ type: "progress", text }] : [];
      if (taskId) {
        events.push({
          type: "claude_runtime_task_progress",
          taskId,
          ...(asString(message.session_id) !== undefined
            ? { sessionId: asString(message.session_id) }
            : {}),
          ...(asString(message.tool_use_id) !== undefined
            ? { toolUseId: asString(message.tool_use_id) }
            : {}),
          ...(description !== undefined ? { description } : {}),
          ...(message.usage !== undefined ? { usage: message.usage } : {}),
          ...(asString(message.last_tool_name) !== undefined
            ? { lastToolName: asString(message.last_tool_name) }
            : {}),
          ...(summary !== undefined ? { summary } : {}),
        });
      }
      return events;
    }
    if (subtype === "hook_progress") {
      const text = asString(message.output) ?? asString(message.stdout) ?? asString(message.stderr);
      return text ? [{ type: "progress", text }] : [];
    }
    return [];
  }

  private mapAssistantMessage(message: Record<string, unknown>): ClaudeClientEvent[] {
    const events: ClaudeClientEvent[] = [];
    const error = asString(message.error);
    if (error) {
      // Python `message_processor._handle_assistant_message` L172-187 정합:
      // AssistantMessage.error는 별 `assistant_error` 이벤트로 발행하여 dashboard가
      // authentication_failed / billing_error / rate_limit 등을 구분 표시 가능.
      // 기존 generic `error{fatal:false}` 패스는 *완전 교체* — permission_denied 분기
      // (mapSystemMessage L394-403)는 별 카테고리라 그대로 유지.
      const nested = asRecord(message.message);
      const model = asString(message.model) ?? asString(nested?.model);
      const messageId = asString(message.message_id) ?? asString(nested?.id);
      events.push({
        type: "assistant_error",
        errorType: error,
        ...(model !== undefined ? { model } : {}),
        ...(messageId !== undefined ? { messageId } : {}),
      });
    }

    const content = messageContent(message);
    for (const block of content) {
      const record = asRecord(block);
      if (!record) continue;

      if (record.type === "text") {
        const text = asString(record.text);
        if (text) events.push({ type: "text", text });
        continue;
      }
      if (record.type === "thinking") {
        const thinking = asString(record.thinking);
        if (thinking) {
          events.push({
            type: "thinking",
            thinking,
            ...(asString(record.signature) ? { signature: asString(record.signature) } : {}),
          });
        }
        continue;
      }
      if (record.type === "tool_use") {
        const toolUseId = asString(record.id) ?? null;
        const toolName = asString(record.name) ?? "tool";
        if (toolUseId) this.toolNamesById.set(toolUseId, toolName);
        this.toolUseTurnOpen = true;
        this.toolUseTurnNeedsSafeDrain = true;
        const toolInput = asRecord(record.input) ?? {};
        if (toolName === "Agent") this.rememberBackgroundAgentToolUse(toolUseId, toolInput);
        events.push({
          type: "tool_start",
          toolName,
          toolInput,
          toolUseId,
        });
        events.push(...this.makeModeEventsFromToolUse(toolName, toolUseId, toolInput));
      }
    }

    return events;
  }

  private mapUserMessage(message: Record<string, unknown>): ClaudeClientEvent[] {
    const events: ClaudeClientEvent[] = [];
    const remoteTrigger = this.mapRemoteOriginUserMessage(message);
    if (remoteTrigger) events.push(remoteTrigger);
    const content = messageContent(message);
    for (const block of content) {
      const record = asRecord(block);
      if (!record || record.type !== "tool_result") continue;

      const toolUseId = asString(record.tool_use_id) ?? null;
      if (toolUseId && this.interceptedScheduleToolUseIds.has(toolUseId)) continue;
      if (toolUseId && this.emittedToolResultIds.has(toolUseId)) continue;
      if (toolUseId) this.emittedToolResultIds.add(toolUseId);
      const toolName = toolUseId ? this.toolNamesById.get(toolUseId) : undefined;
      events.push({
        type: "tool_result",
        toolName,
        toolUseId,
        result: record.content,
        isError: Boolean(record.is_error),
      });
      events.push(
        ...this.mapBackgroundBashTaskFromToolResult({
          toolName,
          toolUseId,
          content: [record.content, message.tool_use_result],
        }),
      );
    }
    return events;
  }

  private mapRemoteOriginUserMessage(message: Record<string, unknown>): ClaudeClientEvent | null {
    const origin = asRecord(message.origin);
    const kind = asString(origin?.kind);
    if (!origin || !kind || kind === "human") return null;
    const prompt = userMessageText(message);
    return {
      type: "claude_runtime_remote_trigger",
      triggerId: asString(message.uuid) ?? randomUUID(),
      source: "message_origin",
      ...(asString(message.session_id) !== undefined
        ? { sessionId: asString(message.session_id) }
        : {}),
      originKind: kind,
      ...(asString(origin.from) !== undefined ? { originFrom: asString(origin.from) } : {}),
      ...(asString(origin.name) !== undefined ? { originName: asString(origin.name) } : {}),
      ...(asString(origin.server) !== undefined ? { originServer: asString(origin.server) } : {}),
      ...(asString(message.priority) !== undefined ? { priority: asString(message.priority) } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
    };
  }

  private mapBackgroundBashTaskFromToolResult(params: {
    toolName?: string;
    toolUseId: string | null;
    content: unknown;
  }): ClaudeClientEvent[] {
    const background = extractBackgroundBashOutput(params.content);
    if (!background.taskId) return [];
    if (params.toolName && params.toolName !== "Bash" && params.toolName !== "bash") {
      return [];
    }

    const patch: Record<string, unknown> = {
      status: "running",
      is_backgrounded: true,
      task_type: "bash",
    };
    if (params.toolUseId) patch.tool_use_id = params.toolUseId;
    if (background.outputFile) patch.output_file = background.outputFile;

    const existing = this.runtimeTasksById.get(background.taskId);
    this.runtimeTasksById.set(background.taskId, {
      status: existing?.status ?? "running",
    });

    const updateEvent: ClaudeClientEvent = {
      type: "claude_runtime_task_updated",
      taskId: background.taskId,
      patch,
    };
    if (existing) return [updateEvent];
    return [
      {
        type: "claude_runtime_task_started",
        taskId: background.taskId,
        ...(params.toolUseId ? { toolUseId: params.toolUseId } : {}),
        taskType: "bash",
        description: "Background Bash task",
      },
      updateEvent,
    ];
  }

  private mapResultMessage(message: Record<string, unknown>): ClaudeClientEvent[] {
    const success = message.subtype === "success" && message.is_error !== true;
    const output = success
      ? asString(message.result) ?? ""
      : firstString(asArray(message.errors)) ??
        asString(message.result) ??
        asString(message.subtype) ??
        "";
    const resultEvent: ClaudeClientEvent = {
      type: "result",
      success,
      output,
      error: success ? null : output,
      usage: message.usage,
      totalCostUsd: asNumber(message.total_cost_usd) ?? null,
      stopReason: asNullableString(message.stop_reason),
      errors: asStringArray(message.errors),
      modelUsage: asRecord(message.modelUsage),
      permissionDenials: permissionDenialsToStrings(message.permission_denials),
    };
    const contextUsageEvent = makeContextUsageEvent(message.usage);

    if (!success) {
      return [
        resultEvent,
        ...(contextUsageEvent ? [contextUsageEvent] : []),
        {
          type: "error",
          message: output || "Claude SDK result indicated failure",
          fatal: true,
          errorCode: resultErrorCode(message),
        },
      ];
    }

    const completeEvent: ClaudeClientEvent = {
      type: "complete",
      result: output,
      claudeSessionId: asString(message.session_id),
      usage: message.usage,
      ...(asNumber(message.total_cost_usd) !== undefined
        ? { totalCostUsd: asNumber(message.total_cost_usd) }
        : {}),
    };
    return [
      resultEvent,
      ...(contextUsageEvent ? [contextUsageEvent] : []),
      completeEvent,
    ];
  }

  private mapPromptSuggestion(message: Record<string, unknown>): ClaudeClientEvent[] {
    const text = asString(message.suggestion)?.trim();
    return text ? [{ type: "prompt_suggestion", text }] : [];
  }

  private mapRateLimit(message: Record<string, unknown>): ClaudeClientEvent[] {
    const info = asRecord(message.rate_limit_info);
    if (!info) return [];
    // Defensive parser — SDK 0.2.x 타입은 camelCase(resetsAt/rateLimitType)이나
    // Python wire 또는 fixture에서 snake_case가 들어올 수 있음. ISO string도 그대로 수용.
    const resetsAtRaw = info.resetsAt ?? info.resets_at;
    const rateLimitTypeRaw = asString(info.rateLimitType) ?? asString(info.rate_limit_type);
    return [
      {
        type: "rate_limit",
        status: asString(info.status),
        resetsAt: coerceResetsAt(resetsAtRaw),
        rateLimitType: rateLimitTypeRaw,
        utilization: asNumber(info.utilization),
      },
    ];
  }

  private makeSubagentStartEvents(
    agentId: string | undefined,
    agentType: string | undefined,
  ): ClaudeClientEvent[] {
    if (this.isBackgroundAgentIdentifier(agentId)) return [];
    if (!agentId || this.emittedSubagentStartIds.has(agentId)) return [];
    this.emittedSubagentStartIds.add(agentId);
    return [
      {
        type: "subagent_start",
        agentId,
        agentType: agentType ?? "task",
      },
    ];
  }

  private makeSubagentStopEvents(agentId: string | undefined): ClaudeClientEvent[] {
    if (this.isBackgroundAgentIdentifier(agentId)) return [];
    if (!agentId || this.emittedSubagentStopIds.has(agentId)) return [];
    this.emittedSubagentStopIds.add(agentId);
    return [{ type: "subagent_stop", agentId }];
  }

  private rememberBackgroundAgentToolUse(
    toolUseId: string | undefined | null,
    toolInput: Record<string, unknown> | undefined,
  ): void {
    if (toolUseId && toolInput?.run_in_background === true) {
      this.backgroundAgentToolUseIds.add(toolUseId);
    }
  }

  private isBackgroundAgentIdentifier(agentId: string | undefined): boolean {
    return !!agentId && (
      this.backgroundAgentTaskIds.has(agentId) ||
      this.backgroundAgentToolUseIds.has(agentId)
    );
  }

  private hasPendingRuntimeWork(): boolean {
    if (this.runtimeSessionState && this.runtimeSessionState !== "idle") return true;
    for (const runtimeTask of this.runtimeTasksById.values()) {
      if (!TERMINAL_CLAUDE_RUNTIME_TASK_STATUSES.has(runtimeTask.status)) return true;
    }
    return false;
  }

  private canAcceptLiveUserInput(): boolean {
    return (
      this.pendingCanUseToolCalls.size === 0 &&
      !this.toolUseTurnOpen &&
      !this.hasPendingRuntimeWork() &&
      !this.hasPendingToolUseResults()
    );
  }

  private hasPendingToolUseResults(): boolean {
    for (const toolUseId of this.toolNamesById.keys()) {
      if (this.interceptedScheduleToolUseIds.has(toolUseId)) continue;
      if (!this.emittedToolResultIds.has(toolUseId)) return true;
    }
    return false;
  }

  private async drainSafeInterventions(): Promise<boolean> {
    const drain = this.activeSafeInterventionDrain;
    if (!drain) return false;
    if (!this.canAcceptLiveUserInput()) return false;
    try {
      const result = await drain();
      return result !== false;
    } catch (err) {
      this.logger.warn({ err }, "safe live intervention drain failed");
      return false;
    }
  }

  private async drainSafeInterventionsAfterResultBoundary(): Promise<boolean> {
    if (!this.toolUseTurnNeedsSafeDrain) return false;
    if (!this.canAcceptLiveUserInput()) return false;
    this.toolUseTurnNeedsSafeDrain = false;
    return await this.drainSafeInterventions();
  }

  private noteResultBoundary(resultEvent: ClaudeClientEvent | undefined): void {
    if (!resultEvent || resultEvent.type !== "result") return;
    if (!resultEvent.success) {
      this.toolUseTurnOpen = false;
      this.toolUseTurnNeedsSafeDrain = false;
      return;
    }
    if (resultEvent.stopReason === "tool_use") {
      this.toolUseTurnOpen = true;
      this.toolUseTurnNeedsSafeDrain = true;
      return;
    }
    if (this.toolUseTurnOpen) {
      this.toolUseTurnOpen = false;
    }
  }

  private consumePendingCompactHookTrigger(trigger: string): boolean {
    const index = this.pendingCompactHookTriggers.indexOf(trigger);
    if (index === -1) return false;
    this.pendingCompactHookTriggers.splice(index, 1);
    return true;
  }

  private shouldRetryAfterCompactNoResult(params: {
    compactSnapshot: number;
    compactRetryCount: number;
    query: ClaudeSdkQuery;
    signal: AbortSignal;
    sawResult: boolean;
  }): boolean {
    if (params.sawResult) return false;
    if (this.compactHookEventCount <= params.compactSnapshot) return false;
    if (params.compactRetryCount >= MAX_COMPACT_RETRIES) return false;
    if (!this.isQueryAlive(params.query, params.signal)) {
      this.logger.warn?.(
        { compactRetryCount: params.compactRetryCount, aborted: params.signal.aborted },
        "compact retry skipped because Claude SDK query is no longer active",
      );
      return false;
    }
    this.logger.info?.(
      { compactRetryCount: params.compactRetryCount + 1, maxRetries: MAX_COMPACT_RETRIES },
      "compact happened without a result; re-entering Claude SDK receive loop",
    );
    return true;
  }

  private isQueryAlive(query: ClaudeSdkQuery, signal: AbortSignal): boolean {
    if (signal.aborted || this.activeQuery !== query) return false;
    const isClosed = asRecord(query)?.isClosed;
    return typeof isClosed === "function" ? isClosed.call(query) !== true : true;
  }

  private normalizeExecutionError(err: unknown, executablePath?: string): Error {
    const rawMessage = err instanceof Error ? err.message : String(err);
    if (executablePath && /ENOENT|not found|no such file/i.test(rawMessage)) {
      return new Error(
        `Claude Code executable failed to start at CLAUDE_CODE_EXECPATH: ${rawMessage}`,
      );
    }
    if (/ENOENT|not found|no such file/i.test(rawMessage)) {
      return new Error(`Claude Code executable failed to start: ${rawMessage}`);
    }
    return err instanceof Error ? err : new Error(rawMessage);
  }

  private clearPerRunState(): void {
    this.abortPendingInputRequests();
    this.toolNamesById.clear();
    this.emittedToolResultIds.clear();
    this.emittedSubagentStartIds.clear();
    this.emittedSubagentStopIds.clear();
    this.interceptedScheduleToolUseIds.clear();
    this.backgroundAgentToolUseIds.clear();
    this.backgroundAgentTaskIds.clear();
    this.pendingCompactHookTriggers.length = 0;
    this.compactHookEventCount = 0;
    this.pendingCanUseToolCalls.clear();
    this.runtimeTasksById.clear();
    this.runtimeSessionState = undefined;
    this.toolUseTurnOpen = false;
    this.toolUseTurnNeedsSafeDrain = false;
  }

  private abortPendingInputRequests(): void {
    for (const [requestId, pending] of this.pendingInputRequests) {
      clearTimeout(pending.timeout);
      this.pendingInputRequests.delete(requestId);
      pending.resolve(INPUT_REQUEST_ABORTED);
    }
  }
}

class PushAsyncIterable<T> implements AsyncIterableIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): boolean {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return true;
    }
    this.values.push(value);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined as T });
    }
  }

  async next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return { done: false, value };
    if (this.closed) return { done: true, value: undefined as T };
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async return(): Promise<IteratorResult<T>> {
    this.close();
    return { done: true, value: undefined as T };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

function createEventQueue<T>(): EventQueue<T> {
  const values: T[] = [];
  const waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (err: unknown) => void;
  }> = [];
  let closed = false;
  let failure: unknown;

  const iterator: EventQueue<T> = {
    push(value) {
      if (closed || failure !== undefined) return false;
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve({ done: false, value });
        return true;
      }
      values.push(value);
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const waiter of waiters.splice(0)) {
        waiter.resolve({ done: true, value: undefined as T });
      }
    },
    fail(err) {
      if (failure !== undefined) return;
      failure = err;
      for (const waiter of waiters.splice(0)) {
        waiter.reject(err);
      }
    },
    async next() {
      if (failure !== undefined) throw failure;
      const value = values.shift();
      if (value !== undefined) return { done: false, value };
      if (closed) return { done: true, value: undefined as T };
      return new Promise<IteratorResult<T>>((resolve, reject) =>
        waiters.push({ resolve, reject }),
      );
    },
    async return() {
      iterator.close();
      return { done: true, value: undefined as T };
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
  return iterator;
}

function makeUserMessage(content: string, imageAttachmentPaths?: string[]): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: buildUserMessageContent(content, imageAttachmentPaths),
    },
    parent_tool_use_id: null,
    priority: "now",
  };
}

type ClaudeUserContentBlock = Exclude<SDKUserMessage["message"]["content"], string>[number];

function buildUserMessageContent(
  prompt: string,
  imageAttachmentPaths?: string[],
): SDKUserMessage["message"]["content"] {
  if (!imageAttachmentPaths || imageAttachmentPaths.length === 0) {
    return prompt;
  }

  const content: ClaudeUserContentBlock[] = [{ type: "text", text: prompt }];
  for (const path of imageAttachmentPaths) {
    content.push(makeImageContentBlock(path));
  }
  return content;
}

function makeImageContentBlock(path: string): ClaudeUserContentBlock {
  const mediaType = getImageAttachmentMediaType(path);
  if (!mediaType) {
    throw new Error(`Unsupported image attachment type: ${path}`);
  }

  let data: string;
  try {
    data = readFileSync(path).toString("base64");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read image attachment ${path}: ${message}`);
  }

  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType,
      data,
    },
  };
}

function messageContent(message: Record<string, unknown>): unknown[] {
  const nested = asRecord(message.message);
  const content = nested?.content ?? message.content;
  if (Array.isArray(content)) return content;
  return [];
}

function userMessageText(message: Record<string, unknown>): string | undefined {
  const nested = asRecord(message.message);
  const content = nested?.content ?? message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((block) => asString(asRecord(block)?.text))
    .filter((text): text is string => Boolean(text));
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function extractBackgroundBashOutput(value: unknown): {
  taskId?: string;
  outputFile?: string;
} {
  const record = extractBackgroundBashOutputRecord(value);
  const taskId =
    asString(record?.backgroundTaskId) ??
    asString(record?.background_task_id);
  const outputFile =
    asString(record?.rawOutputPath) ??
    asString(record?.raw_output_path);
  return {
    ...(taskId ? { taskId } : {}),
    ...(outputFile ? { outputFile } : {}),
  };
}

function extractBackgroundBashOutputRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (record) {
    if (
      asString(record.backgroundTaskId) ||
      asString(record.background_task_id)
    ) {
      return record;
    }
    for (const key of ["content", "text", "tool_use_result"]) {
      const nested = extractBackgroundBashOutputRecord(record[key]);
      if (nested) return nested;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractBackgroundBashOutputRecord(item);
      if (nested) return nested;
    }
    return undefined;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
    try {
      return extractBackgroundBashOutputRecord(JSON.parse(trimmed));
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stripGenericHookOutputFields(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (GENERIC_HOOK_OUTPUT_FIELDS.has(key)) {
      output[key] = STRIPPED_HOOK_OUTPUT;
    } else {
      output[key] = stripGenericHookOutputValue(value);
    }
  }
  return output;
}

function stripGenericHookOutputValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripGenericHookOutputValue(item));
  }
  const record = asRecord(value);
  if (!record) return value;
  return stripGenericHookOutputFields(record);
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNullableString(value: unknown): string | null | undefined {
  return value === null ? null : asString(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resultErrorCode(message: Record<string, unknown>): string {
  const explicitCode = asString(message.error_code) ?? asString(message.errorCode);
  if (explicitCode) return explicitCode;

  const subtype = asString(message.subtype);
  if (message.is_error === true && subtype === "success") {
    return "claude_sdk_result_error";
  }
  return subtype ?? "claude_sdk_result_error";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRuntimeSystemMessage(message: Record<string, unknown> | undefined): boolean {
  if (message?.type !== "system") return false;
  return (
    message.subtype === "session_state_changed" ||
    message.subtype === "task_started" ||
    message.subtype === "task_updated" ||
    message.subtype === "task_progress" ||
    message.subtype === "task_notification" ||
    message.subtype === "notification" ||
    message.subtype === "mirror_error"
  );
}

function isRuntimeClientEvent(event: ClaudeClientEvent): boolean {
  return event.type.startsWith("claude_runtime_");
}

function isFatalClientError(event: ClaudeClientEvent): boolean {
  return event.type === "error" && event.fatal !== false;
}

function parseRuntimeSessionState(value: unknown): ClaudeRuntimeSessionState | undefined {
  return value === "idle" || value === "running" || value === "requires_action"
    ? value
    : undefined;
}

function parseRuntimeTaskStatus(value: unknown): ClaudeRuntimeTaskStatus | undefined {
  return value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "stopped" ||
    value === "killed"
    ? value
    : undefined;
}

function parseRuntimeNotificationStatus(
  value: unknown,
): "completed" | "failed" | "stopped" | undefined {
  return value === "completed" || value === "failed" || value === "stopped"
    ? value
    : undefined;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

function firstString(value: unknown[] | undefined): string | undefined {
  return value?.find((item): item is string => typeof item === "string");
}

function permissionDenialsToStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((item) => {
    const record = asRecord(item);
    const toolName = asString(record?.tool_name) ?? "tool";
    const toolUseId = asString(record?.tool_use_id);
    return toolUseId ? `${toolName}:${toolUseId}` : toolName;
  });
}

function buildMcpOptions(
  options: ClaudeRunOptions,
  logger: Logger,
): Partial<ClaudeSdkOptions> {
  if (options.useMcp === false) return {};
  const mcpServers = loadMcpServers(options.workspaceDir, logger);
  if (mcpServers === undefined) return {};
  return {
    mcpServers: injectAgentSessionHeaderIntoMcpServers(
      mcpServers,
      options.agentSessionId,
    ),
  };
}

function loadMcpServers(
  workspaceDir: string,
  logger: Logger,
): Record<string, McpServerConfig> | undefined {
  const configPath = join(workspaceDir, MCP_CONFIG_FILE);
  if (!existsSync(configPath)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(
      `Failed to read Claude MCP config at ${configPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const root = asRecord(parsed);
  if (!root) {
    throw new Error(`Claude MCP config at ${configPath} must be a JSON object`);
  }

  const servers = asRecord(root.mcpServers) ?? root;
  logger.debug(
    { configPath, serverNames: Object.keys(servers) },
    "Loaded Claude MCP config",
  );
  return servers as Record<string, McpServerConfig>;
}

function injectAgentSessionHeaderIntoMcpServers(
  servers: Record<string, McpServerConfig>,
  agentSessionId: string | undefined,
): Record<string, McpServerConfig> {
  const callerSessionId = agentSessionId?.trim();
  if (!callerSessionId) return servers;

  const patched: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    patched[name] = injectAgentSessionHeaderIntoMcpServer(
      config,
      callerSessionId,
    );
  }
  return patched;
}

function injectAgentSessionHeaderIntoMcpServer(
  config: McpServerConfig,
  agentSessionId: string,
): McpServerConfig {
  const record = asRecord(config);
  const type = asString(record?.type);
  if (type !== "sse" && type !== "streamable_http" && type !== "http") {
    return config;
  }

  return {
    ...record,
    headers: mergeAgentSessionHeader(record?.headers, agentSessionId),
  } as McpServerConfig;
}

function mergeAgentSessionHeader(
  headers: unknown,
  agentSessionId: string,
): Record<string, string> {
  const merged: Record<string, string> = {};
  const record = asRecord(headers);
  if (record) {
    for (const [key, value] of Object.entries(record)) {
      if (key.toLowerCase() === SOULSTREAM_AGENT_SESSION_HEADER) continue;
      if (typeof value === "string") {
        merged[key] = value;
      }
    }
  }
  merged[SOULSTREAM_AGENT_SESSION_HEADER] = agentSessionId;
  return merged;
}

function compactMessage(trigger: string): string {
  return `Claude session compacted (${trigger})`;
}

function makeContextUsageEvent(usage: unknown): ClaudeClientEvent | undefined {
  const record = asRecord(usage);
  if (!record) return undefined;

  const inputTokens = asNumber(record.input_tokens) ?? asNumber(record.inputTokens) ?? 0;
  const outputTokens = asNumber(record.output_tokens) ?? asNumber(record.outputTokens) ?? 0;
  const cacheCreationTokens =
    asNumber(record.cache_creation_input_tokens)
    ?? asNumber(record.cacheCreationInputTokens)
    ?? sumNumericObject(record.cache_creation)
    ?? sumNumericObject(record.cacheCreation)
    ?? 0;
  const cacheReadTokens =
    asNumber(record.cache_read_input_tokens)
    ?? asNumber(record.cacheReadInputTokens)
    ?? 0;
  const usedTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
  if (usedTokens <= 0) return undefined;

  return {
    type: "context_usage",
    usedTokens,
    maxTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    percent: Math.round((usedTokens / DEFAULT_MAX_CONTEXT_TOKENS) * 1000) / 10,
  };
}

function makeCacheableSystemPrompt(systemPrompt: string | string[]): string[] {
  // Prompt caching lowers cost/latency, but the prompt still counts in the request context.
  if (Array.isArray(systemPrompt)) {
    if (systemPrompt.includes(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)) return systemPrompt;
    return [...systemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY];
  }
  return [systemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY];
}

function makeCompactSystemReminder(systemPrompt: string[] | undefined): string | undefined {
  const promptBlocks = systemPrompt
    ?.filter((block) => block !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  if (!promptBlocks || promptBlocks.length === 0) return undefined;
  return `${COMPACT_SYSTEM_REMINDER_HEADER}\n\n<system_prompt>\n${promptBlocks.join("\n\n")}\n</system_prompt>`;
}

export function resolveClaudeExecutableFromPath(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? env.path;
  if (!pathValue) return undefined;

  const candidateNames = platform === "win32" ? ["claude.exe"] : ["claude"];

  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const name of candidateNames) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Try the next PATH candidate.
      }
    }
  }
  return undefined;
}

function sumNumericObject(value: unknown): number | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  let total = 0;
  for (const item of Object.values(record)) {
    if (typeof item === "number" && Number.isFinite(item)) {
      total += item;
    }
  }
  return total > 0 ? total : undefined;
}

function epochNumberToIso(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const millis = value > 1_000_000_000_000 ? value : value * 1_000;
  return new Date(millis).toISOString();
}

/**
 * rate_limit_info.resetsAt 값을 SSE wire용 ISO 문자열로 정규화.
 *
 * 수용 입력:
 *   - epoch seconds (≤ 1e12): Date 객체로 변환 후 ISO
 *   - epoch milliseconds (> 1e12): Date 객체로 변환 후 ISO
 *   - ISO 문자열: 그대로 passthrough
 *   - undefined / 그 외: undefined
 */
function coerceResetsAt(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return epochNumberToIso(value);
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return undefined;
}
