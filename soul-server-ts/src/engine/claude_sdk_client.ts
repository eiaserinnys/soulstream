import {
  query as defaultQuery,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  Options as ClaudeSdkOptions,
  Query as ClaudeSdkQuery,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { ClaudeClient, ClaudeRunOptions } from "./claude_adapter.js";
import { resolveClaudeExecutableFromPath } from "./claude_executable_path.js";
import type { ClaudeClientEvent } from "./claude_event_mapper.js";
import {
  ClaudePostResultDrain,
  MAX_COMPACT_RETRIES,
  type PostResultContinuationKind,
} from "./claude_sdk_drain.js";
import {
  createEventQueue,
  type EventQueue,
} from "./claude_sdk_event_queue.js";
import { ClaudeSdkEventMapper } from "./claude_sdk_event_mapper.js";
import { asRecord } from "./claude_sdk_helpers.js";
import { buildClaudeSdkHooks } from "./claude_sdk_hooks.js";
import { buildMcpOptions } from "./claude_sdk_mcp_options.js";
import {
  makeCacheableSystemPrompt,
} from "./claude_sdk_prompt.js";
import { ClaudeRuntimeState } from "./claude_sdk_runtime_state.js";
import { ClaudeSdkToolPermissionController } from "./claude_sdk_tool_permissions.js";
import { makeUserMessage } from "./claude_sdk_user_message.js";
import type {
  ClaudeBackgroundTaskControlResult,
  EngineUserInput,
  LiveTurnSteerResult,
} from "./protocol.js";

export { resolveClaudeExecutableFromPath } from "./claude_executable_path.js";

const CLAUDE_CODE_EXECPATH_ENV = "CLAUDE_CODE_EXECPATH";
const DEFAULT_INPUT_REQUEST_TIMEOUT_MS = 300_000;
/**
 * Result 도착 후 SDK가 발행하는 `prompt_suggestion` 메시지를 받기 위한 short drain 시간.
 *
 * Legacy prompt_suggestion drain timeout 2초 정본 정합.
 * SDK 0.2.x 타입 정의 (sdk.d.ts) 명시:
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

export class ClaudeSdkClient implements ClaudeClient {
  private readonly queryFn: ClaudeSdkQueryFn;
  private readonly logger: Logger;
  private readonly postResultDrainMs: number;
  private readonly runtimeDrainMaxMs: number;
  private readonly resolveClaudeExecutablePath: () => string | undefined;
  private readonly runtimeState: ClaudeRuntimeState;
  private readonly eventMapper: ClaudeSdkEventMapper;
  private readonly toolPermissionController: ClaudeSdkToolPermissionController;
  private readonly postResultDrainer: ClaudePostResultDrain;

  private activeQuery: ClaudeSdkQuery | null = null;
  private activeInput: EventQueue<SDKUserMessage> | null = null;
  private lastWorkspaceDir: string | null = null;
  private lastEnv: Record<string, string> | undefined;

  constructor(config: ClaudeSdkClientConfig = {}, logger: Logger) {
    this.queryFn = config.query ?? defaultQuery;
    this.logger = logger;
    const inputRequestTimeoutMs =
      config.inputRequestTimeoutMs ?? DEFAULT_INPUT_REQUEST_TIMEOUT_MS;
    this.postResultDrainMs =
      config.postResultDrainMs ?? DEFAULT_POST_RESULT_DRAIN_MS;
    this.runtimeDrainMaxMs =
      config.runtimeDrainMaxMs ?? DEFAULT_CLAUDE_RUNTIME_DRAIN_MAX_MS;
    this.resolveClaudeExecutablePath =
      config.resolveClaudeExecutablePath ?? resolveClaudeExecutableFromPath;
    this.runtimeState = new ClaudeRuntimeState();
    this.eventMapper = new ClaudeSdkEventMapper(this.runtimeState);
    this.toolPermissionController = new ClaudeSdkToolPermissionController({
      inputRequestTimeoutMs,
      eventMapper: this.eventMapper,
    });
    this.postResultDrainer = new ClaudePostResultDrain({
      logger: this.logger,
      postResultDrainMs: this.postResultDrainMs,
      runtimeDrainMaxMs: this.runtimeDrainMaxMs,
      eventMapper: this.eventMapper,
      runtimeState: this.runtimeState,
    });
  }

  async *run(options: ClaudeRunOptions, signal: AbortSignal): AsyncIterable<ClaudeClientEvent> {
    this.lastWorkspaceDir = options.workspaceDir;
    this.lastEnv = options.env;
    this.clearPerRunState();

    const output = createEventQueue<ClaudeClientEvent>();
    const input = createEventQueue<SDKUserMessage>();
    input.push(makeUserMessage(options.prompt, options.imageAttachmentPaths));

    const abortController = new AbortController();
    const abortSdk = () => abortController.abort(signal.reason);
    if (signal.aborted) {
      abortSdk();
    } else {
      signal.addEventListener("abort", abortSdk, { once: true });
    }

    const queryOptions = this.buildSdkOptions(options, abortController, output);
    let query: ClaudeSdkQuery;
    this.activeInput = input;
    try {
      query = this.queryFn({ prompt: input, options: queryOptions });
    } catch (err) {
      this.closeActiveInput(input);
      signal.removeEventListener("abort", abortSdk);
      throw this.normalizeExecutionError(err, queryOptions.pathToClaudeCodeExecutable);
    }
    this.activeQuery = query;
    const pump = this.pumpQuery(query, output, abortController.signal, input);

    try {
      for await (const event of output) {
        yield event;
      }
      await pump;
    } catch (err) {
      throw this.normalizeExecutionError(err, queryOptions.pathToClaudeCodeExecutable);
    } finally {
      signal.removeEventListener("abort", abortSdk);
      if (this.activeQuery === query) this.activeQuery = null;
      this.closeActiveInput(input);
      this.toolPermissionController.abortPendingInputRequests();
      await pump.catch(() => undefined);
    }
  }

  async compact(sessionId: string): Promise<void> {
    if (!this.lastWorkspaceDir) {
      throw new Error("ClaudeSdkClient.compact requires a previous run context");
    }

    const controller = new AbortController();
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
      query = this.queryFn({ prompt: "/compact", options: queryOptions });
    } catch (err) {
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
      if (this.activeQuery === query) this.activeQuery = null;
    }
  }

  deliverInputResponse(requestId: string, answers: Record<string, unknown>): boolean {
    return this.toolPermissionController.deliverInputResponse(requestId, answers);
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
    this.toolPermissionController.abortPendingInputRequests();
    return true;
  }

  async interruptActiveTurnForSteer(): Promise<boolean> {
    const query = this.activeQuery;
    if (!query) return false;
    try {
      await query.interrupt();
    } catch (err) {
      this.logger.warn({ err }, "Claude SDK steer interrupt failed");
      return false;
    }
    this.toolPermissionController.abortPendingInputRequests();
    return true;
  }

  async steerActiveTurn(input: EngineUserInput): Promise<LiveTurnSteerResult> {
    void input;
    return {
      status: "not_supported",
      message: "Claude live steering uses interruptActiveTurnForSteer",
    };
  }

  async close(): Promise<void> {
    this.closeActiveInput();
    this.activeQuery?.close();
    this.toolPermissionController.abortPendingInputRequests();
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
      canUseTool: this.toolPermissionController.makeCanUseTool(output, options),
      hooks: buildClaudeSdkHooks({
        output,
        systemPrompt,
        eventMapper: this.eventMapper,
        runtimeState: this.runtimeState,
        logger: this.logger,
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
      ...buildMcpOptions(options, this.logger),
    };
  }

  private async pumpQuery(
    query: ClaudeSdkQuery,
    output: EventQueue<ClaudeClientEvent>,
    signal: AbortSignal,
    input: EventQueue<SDKUserMessage>,
  ): Promise<void> {
    try {
      let compactRetryCount = 0;
      for (;;) {
        const queryIter = query[Symbol.asyncIterator]();
        const compactSnapshot = this.eventMapper.getCompactHookEventCount();
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
            if (this.runtimeState.hasPendingWork()) {
              output.push({
                type: "error",
                fatal: true,
                errorCode: "claude_runtime_ended_before_idle",
                message: "Claude SDK stream ended while runtime work was still pending.",
              });
            }
            this.closeActiveInput(input);
            output.close();
            return;
          }
          const message = next.value;

          const msg = asRecord(message);
          if (msg?.type === "result") {
            sawResult = true;
            this.closeActiveInput(input);
            const terminalEvents = this.eventMapper.mapResultMessage(msg);
            const resultEvent = terminalEvents.find((event) => event.type === "result");
            const continuations =
              resultEvent?.type === "result"
                ? this.postResultDrainer.postResultContinuations(resultEvent, compactRetryCount)
                : new Set<PostResultContinuationKind>();

            const drain = await this.postResultDrainer.drainAfterResult(queryIter, continuations);

            if (drain.action === "continue") {
              if (drain.reason === "compact_boundary") compactRetryCount += 1;
              for (const event of drain.events) output.push(event);
              continue;
            }

            for (const event of this.postResultDrainer.orderTerminalEvents(terminalEvents, drain.events)) {
              output.push(event);
            }
            query.close();
            output.close();
            return;
          }

          let shouldStop = false;
          for (const event of this.eventMapper.mapSdkMessage(message)) {
            output.push(event);
            if (event.type === "complete" || (event.type === "error" && event.fatal !== false)) {
              shouldStop = true;
            }
          }
          if (shouldStop) {
            this.closeActiveInput(input);
            // Result/complete (또는 fatal error) 도착 — post-result drain phase로 진입.
            // Python `receive_loop._drain_after_result` (L126-188) 정합:
            //   - prompt_suggestion 1메시지를 best-effort로 기다림 (default 2초)
            //   - 그 외 메시지(StreamEvent · stray assistant 등)는 narrowing → logger.warn 후 무시
            //   - timeout / EOS / 에러 모두 조용히 종료 (drain은 부가 기능, §8 실패 격리)
            const drain = await this.postResultDrainer.drainAfterResult(
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

  private shouldRetryAfterCompactNoResult(params: {
    compactSnapshot: number;
    compactRetryCount: number;
    query: ClaudeSdkQuery;
    signal: AbortSignal;
    sawResult: boolean;
  }): boolean {
    if (params.sawResult) return false;
    if (this.eventMapper.getCompactHookEventCount() <= params.compactSnapshot) return false;
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
    this.toolPermissionController.clearPerRunState();
    this.eventMapper.clearPerRunState();
    this.runtimeState.clear();
  }

  private closeActiveInput(input: EventQueue<SDKUserMessage> | null = this.activeInput): void {
    if (!input) return;
    input.close();
    if (this.activeInput === input) this.activeInput = null;
  }
}
