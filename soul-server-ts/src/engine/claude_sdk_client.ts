import { query as defaultQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options as ClaudeSdkOptions,
  Query as ClaudeSdkQuery,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { RunnerControlFrame } from "../runner/frame_protocol.js";
import type { ClaudeClient, ClaudeRunOptions } from "./claude_adapter.js";
import { buildClaudeCompactRunOptions, consumeClaudeCompact } from "./claude_sdk_compact.js";
import { resolveClaudeExecutableFromPath } from "./claude_executable_path.js";
import type { ClaudeClientEvent } from "./claude_event_mapper.js";
import { ClaudePostResultDrain } from "./claude_sdk_drain.js";
import {
  createEventQueue,
  type EventQueue,
} from "./claude_sdk_event_queue.js";
import { ClaudeSdkEventMapper } from "./claude_sdk_event_mapper.js";
import { buildClaudeSdkHooks } from "./claude_sdk_hooks.js";
import { pumpLegacyClaudeQuery } from "./claude_sdk_legacy_pump.js";
import { buildMcpOptions } from "./claude_sdk_mcp_options.js";
import {
  ClaudeSdkPersistentSession,
  type ClaudeDetachedEventSink,
  type ClaudeRuntimeEventSink,
} from "./claude_sdk_persistent_session.js";
import { makeCacheableSystemPrompt } from "./claude_sdk_prompt.js";
import { ClaudeRuntimeState } from "./claude_sdk_runtime_state.js";
import { ClaudeSdkToolPermissionController } from "./claude_sdk_tool_permissions.js";
import { makeUserMessage } from "./claude_sdk_user_message.js";
import { spawnClaudeSessionEngine } from "./session_engine_oom_score.js";
import type { ClaudePersistentRuntimeActivity } from "./claude_session_runtime.js";
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
  detachedEventSink?: ClaudeDetachedEventSink;
  runtimeEventSink?: ClaudeRuntimeEventSink;
  /** Maximum gap between user-visible foreground activity frames. */
  persistentTurnInactivityTimeoutMs?: number;
  runtimeFollowupNoOutputTimeoutMs?: number;
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
  private readonly detachedEventSink: ClaudeDetachedEventSink;
  private readonly runtimeEventSink?: ClaudeRuntimeEventSink;
  private readonly persistentTurnInactivityTimeoutMs: number;
  private readonly runtimeFollowupNoOutputTimeoutMs: number;
  private activeQuery: ClaudeSdkQuery | null = null;
  private activeInput: EventQueue<SDKUserMessage> | null = null;
  private lastWorkspaceDir: string | null = null;
  private lastEnv: Record<string, string> | undefined;
  private lastRunOptions: ClaudeRunOptions | null = null;
  private persistentSession: ClaudeSdkPersistentSession | null = null;

  constructor(config: ClaudeSdkClientConfig = {}, logger: Logger) {
    this.queryFn = config.query ?? defaultQuery;
    this.logger = logger;
    const inputRequestTimeoutMs = config.inputRequestTimeoutMs ?? DEFAULT_INPUT_REQUEST_TIMEOUT_MS;
    this.postResultDrainMs = config.postResultDrainMs ?? DEFAULT_POST_RESULT_DRAIN_MS;
    this.runtimeDrainMaxMs = config.runtimeDrainMaxMs ?? DEFAULT_CLAUDE_RUNTIME_DRAIN_MAX_MS;
    this.resolveClaudeExecutablePath = config.resolveClaudeExecutablePath
      ?? resolveClaudeExecutableFromPath;
    this.runtimeState = new ClaudeRuntimeState(config.runtimeEventSink !== undefined);
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
    this.detachedEventSink = config.detachedEventSink ?? (async () => undefined);
    this.runtimeEventSink = config.runtimeEventSink;
    this.persistentTurnInactivityTimeoutMs =
      config.persistentTurnInactivityTimeoutMs ?? 600_000;
    this.runtimeFollowupNoOutputTimeoutMs = config.runtimeFollowupNoOutputTimeoutMs ?? 30_000;
  }

  async *run(options: ClaudeRunOptions, signal: AbortSignal): AsyncIterable<ClaudeClientEvent> {
    this.lastWorkspaceDir = options.workspaceDir;
    this.lastEnv = options.env;
    this.lastRunOptions = options;
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
    const pump = pumpLegacyClaudeQuery({
      query,
      output,
      signal: abortController.signal,
      input,
      eventMapper: this.eventMapper,
      postResultDrainer: this.postResultDrainer,
      runtimeState: this.runtimeState,
      logger: this.logger,
      isQueryActive: (candidate) => this.isQueryActive(candidate),
      closeInput: (candidate) => this.closeActiveInput(candidate),
    });

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

  async *runPersistent(
    options: ClaudeRunOptions,
    signal: AbortSignal,
  ): AsyncIterable<ClaudeClientEvent> {
    this.lastWorkspaceDir = options.workspaceDir;
    this.lastEnv = options.env;
    this.lastRunOptions = options;
    let persistentSession = this.persistentSession;
    if (
      persistentSession
      && persistentSession.snapshot().queryLifecycle !== "open"
    ) {
      if (this.persistentSession === persistentSession) {
        this.persistentSession = null;
        this.activeQuery = null;
      }
      persistentSession = null;
    }
    if (!persistentSession) {
      this.clearPerRunState();
      const hookOutput = createEventQueue<ClaudeClientEvent>();
      const abortController = new AbortController();
      const { maxTurns: _queryGlobalMaxTurns, ...persistentOptions } = options;
      const queryOptions = this.buildSdkOptions(
        persistentOptions,
        abortController,
        hookOutput,
      );
      let createdSession!: ClaudeSdkPersistentSession;
      createdSession = new ClaudeSdkPersistentSession({
        createQuery: (input) => {
          let query: ClaudeSdkQuery;
          try {
            query = this.queryFn({ prompt: input, options: queryOptions });
          } catch (err) {
            throw this.normalizeExecutionError(err, queryOptions.pathToClaudeCodeExecutable);
          }
          this.activeQuery = query;
          return query;
        },
        eventMapper: this.eventMapper,
        hookOutput,
        detachedEventSink: this.detachedEventSink,
        runtimeEventSink: this.runtimeEventSink,
        logger: this.logger,
        postResultDrainMs: this.postResultDrainMs,
        turnInactivityTimeoutMs: this.persistentTurnInactivityTimeoutMs,
        runtimeFollowupNoOutputTimeoutMs: this.runtimeFollowupNoOutputTimeoutMs,
        onClosed: () => {
          if (this.persistentSession === createdSession) {
            this.activeQuery = null;
            this.persistentSession = null;
          }
        },
      });
      this.persistentSession = createdSession;
      persistentSession = createdSession;
    }

    try {
      for await (const event of persistentSession.runTurn(options, signal)) {
        yield event;
      }
    } catch (err) {
      throw this.normalizeExecutionError(err);
    }
  }

  async compact(sessionId: string): Promise<void> {
    if (!this.lastWorkspaceDir || !this.lastRunOptions) {
      throw new Error("ClaudeSdkClient.compact requires a previous run context");
    }

    const controller = new AbortController();
    const output = createEventQueue<ClaudeClientEvent>();
    const queryOptions = this.buildSdkOptions(
      buildClaudeCompactRunOptions(
        this.lastRunOptions,
        this.lastWorkspaceDir,
        sessionId,
        this.lastEnv,
      ),
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
      await consumeClaudeCompact(query);
    } catch (err) {
      throw this.normalizeExecutionError(err, queryOptions.pathToClaudeCodeExecutable);
    } finally {
      if (this.activeQuery === query) this.activeQuery = null;
    }
  }

  sendControlFrame(frame: RunnerControlFrame): boolean {
    if (frame.kind !== "input_response") return false;
    return this.toolPermissionController.deliverInputResponse(frame.correlationId, frame.answers);
  }

  persistentRuntimeActivity(): ClaudePersistentRuntimeActivity | null {
    const snapshot = this.persistentSession?.snapshot();
    if (!snapshot) return null;
    return {
      foregroundPhase: snapshot.foregroundPhase,
      queryLifecycle: snapshot.queryLifecycle,
      backgroundTaskCount: snapshot.backgroundTaskIds.length,
      pendingInputRequestCount:
        this.toolPermissionController.pendingInputRequestCount(),
      pendingRuntimeSignalCount: this.runtimeState.hasPendingWork() ? 1 : 0,
    };
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
    if (this.persistentSession) {
      await this.persistentSession.close("explicit_cancel");
      this.toolPermissionController.abortPendingInputRequests();
      return true;
    }
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
    if (this.persistentSession) {
      const interrupted = await this.persistentSession.interruptForeground();
      if (interrupted) this.toolPermissionController.abortPendingInputRequests();
      return interrupted;
    }
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

  async close(
    reason: import("./claude_session_runtime.js").ClaudeRuntimeCloseReason = "shutdown",
  ): Promise<void> {
    if (this.persistentSession) {
      const persistent = this.persistentSession;
      await persistent.close(reason);
      this.toolPermissionController.abortPendingInputRequests();
      await persistent.settled();
      this.persistentSession = null;
    }
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
      ...(process.platform === "linux"
        ? { spawnClaudeCodeProcess: (spawnOptions) => spawnClaudeSessionEngine(spawnOptions, this.logger) }
        : {}),
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

  private isQueryActive(query: ClaudeSdkQuery): boolean {
    return this.activeQuery === query;
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
