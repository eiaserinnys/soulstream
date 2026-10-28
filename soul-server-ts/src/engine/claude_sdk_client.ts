import { query as defaultQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options as ClaudeSdkOptions,
  Query as ClaudeSdkQuery,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { RunnerControlFrame } from "../runner/frame_protocol.js";
import type { ClaudeClient, ClaudeRunOptions } from "./claude_adapter.js";
import { AsyncMutex } from "./async_mutex.js";
import { ClaudeAccountQuerySettlement } from "./claude_account_query_settlement.js";
import {
  compactClaudeSdkSession,
  type ClaudeSdkClientCompactOptions,
} from "./claude_sdk_client_compact.js";
import { resolveClaudeExecutableFromPath } from "./claude_executable_path.js";
import { isMissingSpawnExecutableError } from "./claude_spawn_errors.js";
import type { ClaudeClientEvent } from "./claude_client_event.js";
import { ClaudePostResultDrain } from "./claude_sdk_drain.js";
import {
  createEventQueue,
  type EventQueue,
} from "./claude_sdk_event_queue.js";
import { ClaudeSdkEventMapper } from "./claude_sdk_event_mapper.js";
import { pumpLegacyClaudeQuery } from "./claude_sdk_legacy_pump.js";
import { buildClaudeSdkOptions } from "./claude_sdk_options.js";
import {
  ClaudeSdkPersistentSession,
  type ClaudeDetachedEventSink,
  type ClaudeRuntimeEventSink,
} from "./claude_sdk_persistent_session.js";
import { ClaudeRuntimeState } from "./claude_sdk_runtime_state.js";
import { ClaudeSdkToolPermissionController } from "./claude_sdk_tool_permissions.js";
import { ClaudeSdkRuntimeControls } from "./claude_sdk_runtime_controls.js";
import {
  DEFAULT_CLAUDE_RUNTIME_DRAIN_MAX_MS,
  DEFAULT_INPUT_REQUEST_TIMEOUT_MS,
  DEFAULT_POST_RESULT_DRAIN_MS,
} from "./claude_sdk_client_defaults.js";
import { makeUserMessage } from "./claude_sdk_user_message.js";
import type { ClaudePersistentRuntimeActivity } from "./claude_session_runtime.js";
import type {
  ClaudeBackgroundTaskControlResult,
  CompactedContextUsage,
  EngineUserInput,
} from "./protocol.js";

export { resolveClaudeExecutableFromPath } from "./claude_executable_path.js";
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
  private readonly runtimeControls: ClaudeSdkRuntimeControls;
  private readonly compactContext: ClaudeSdkClientCompactOptions;
  private readonly detachedEventSink: ClaudeDetachedEventSink;
  private readonly runtimeEventSink?: ClaudeRuntimeEventSink;
  private readonly persistentTurnInactivityTimeoutMs: number;
  private readonly runtimeFollowupNoOutputTimeoutMs: number;
  private activeQuery: ClaudeSdkQuery | null = null;
  private activeQueryPump: Promise<void> | null = null;
  private activeInput: EventQueue<SDKUserMessage> | null = null;
  private lastWorkspaceDir: string | null = null;
  private lastEnv: Record<string, string> | undefined;
  private lastRunOptions: ClaudeRunOptions | null = null;
  private persistentSession: ClaudeSdkPersistentSession | null = null;
  private persistentConfigDir: string | null = null;
  private persistentConfigDirKnown = false;
  private readonly accountQuerySettlement: ClaudeAccountQuerySettlement;
  private readonly childExitPromises = new Set<Promise<void>>();
  private readonly turnMutex = new AsyncMutex();

  constructor(config: ClaudeSdkClientConfig = {}, logger: Logger) {
    this.queryFn = config.query ?? defaultQuery;
    this.logger = logger;
    this.accountQuerySettlement = new ClaudeAccountQuerySettlement(() => this.waitForChildExit(), logger);
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
    this.runtimeControls = new ClaudeSdkRuntimeControls({
      logger: this.logger,
      runtimeState: this.runtimeState,
      toolPermissionController: this.toolPermissionController,
      activeQuery: () => this.activeQuery,
      persistentSession: () => this.persistentSession,
      lastRunOptions: () => this.lastRunOptions,
      closePersistentAndSettle: (persistent, reason) =>
        this.closePersistentAndSettle(persistent, reason),
      waitForChildExit: () => this.waitForChildExit(),
    });
    this.compactContext = {
      queryFn: this.queryFn,
      logger: this.logger,
      resolveClaudeExecutablePath: this.resolveClaudeExecutablePath,
      eventMapper: this.eventMapper,
      runtimeState: this.runtimeState,
      toolPermissionController: this.toolPermissionController,
      lastRunOptions: () => this.lastRunOptions,
      lastWorkspaceDir: () => this.lastWorkspaceDir,
      lastEnv: () => this.lastEnv,
      persistentSession: () => this.persistentSession,
      setActiveQuery: (query) => { this.activeQuery = query; },
      isActiveQuery: (query) => this.activeQuery === query,
      trackChildExit: (closed) => this.trackChildExit(closed),
      waitForChildExit: () => this.waitForChildExit(),
      closePersistentAndSettle: (persistent) =>
        this.closePersistentAndSettle(persistent, "explicit_cancel"),
      normalizeExecutionError: (error, executablePath) =>
        this.normalizeExecutionError(error, executablePath),
    };
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
      config.persistentTurnInactivityTimeoutMs ?? 1_200_000;
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

    const queryOptions = buildClaudeSdkOptions({
      options,
      abortController,
      output,
      logger: this.logger,
      resolveClaudeExecutablePath: this.resolveClaudeExecutablePath,
      eventMapper: this.eventMapper,
      runtimeState: this.runtimeState,
      toolPermissionController: this.toolPermissionController,
      ...(options.trackChildExit
        ? { onChildProcessClosed: (closed) => this.trackChildExit(closed) }
        : {}),
    });
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
    this.activeQueryPump = pump;

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
      if (this.activeQueryPump === pump) this.activeQueryPump = null;
      if (options.trackChildExit) await this.waitForChildExit();
      await options.onAccountQueryClosed?.();
    }
  }

  async *runPersistent(
    options: ClaudeRunOptions,
    signal: AbortSignal,
  ): AsyncIterable<ClaudeClientEvent> {
    if (!options.trackChildExit) {
      yield* this.runPersistentLocked(options, signal);
      return;
    }
    const releaseTurn = await this.turnMutex.acquire();
    try {
      yield* this.runPersistentLocked(options, signal);
    } finally {
      releaseTurn();
    }
  }

  private async *runPersistentLocked(
    options: ClaudeRunOptions,
    signal: AbortSignal,
  ): AsyncIterable<ClaudeClientEvent> {
    try {
      yield* this.runPersistentTurn(options, signal);
    } finally {
      const persistentSession = this.persistentSession;
      if (
        options.trackChildExit
        && (!persistentSession || persistentSession.snapshot().queryLifecycle !== "open")
      ) {
        await persistentSession?.settled();
        await this.waitForChildExit();
        await this.accountQuerySettlement.settle();
      }
    }
  }

  private async *runPersistentTurn(
    options: ClaudeRunOptions,
    signal: AbortSignal,
  ): AsyncIterable<ClaudeClientEvent> {
    this.lastWorkspaceDir = options.workspaceDir;
    this.lastEnv = options.env;
    this.lastRunOptions = options;
    let persistentSession = this.persistentSession;
    const nextConfigDir = options.env?.CLAUDE_CONFIG_DIR ?? null;
    if (
      options.trackChildExit
      &&
      persistentSession
      && this.persistentConfigDirKnown
      && this.persistentConfigDir !== nextConfigDir
      && (this.persistentConfigDir !== null || nextConfigDir !== null)
    ) {
      await this.closePersistentAndSettle(persistentSession, "explicit_cancel");
      persistentSession = null;
    }
    if (
      persistentSession
      && persistentSession.snapshot().queryLifecycle !== "open"
    ) {
      if (options.trackChildExit) await persistentSession.settled();
      if (this.persistentSession === persistentSession) {
        this.persistentSession = null;
        this.activeQuery = null;
      }
      persistentSession = null;
      if (options.trackChildExit) await this.waitForChildExit();
      await this.accountQuerySettlement.settle();
    }
    if (!persistentSession && options.trackChildExit) {
      await this.waitForChildExit();
      await this.accountQuerySettlement.settle();
    }
    if (options.trackChildExit && signal.aborted) return;
    const { maxTurns, ...persistentOptions } = options;
    if (maxTurns !== undefined) {
      this.logger.warn(
        { maxTurns },
        "Claude SDK persistent runtime ignores maxTurns; the limit only applies to one-shot queries",
      );
    }
    if (!persistentSession) {
      this.clearPerRunState();
      const hookOutput = createEventQueue<ClaudeClientEvent>();
      const abortController = new AbortController();
      const queryOptions = buildClaudeSdkOptions({
        options: persistentOptions,
        abortController,
        output: hookOutput,
        logger: this.logger,
        resolveClaudeExecutablePath: this.resolveClaudeExecutablePath,
        eventMapper: this.eventMapper,
        runtimeState: this.runtimeState,
        toolPermissionController: this.toolPermissionController,
        ...(options.trackChildExit
          ? { onChildProcessClosed: (closed) => this.trackChildExit(closed) }
          : {}),
      });
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
            this.accountQuerySettlement.queryClosed(createdSession);
          }
        },
      });
      this.persistentSession = createdSession;
      persistentSession = createdSession;
      this.persistentConfigDir = nextConfigDir;
      this.persistentConfigDirKnown = true;
    }
    this.accountQuerySettlement.bind(options.onAccountQueryClosed);
    options.onAccountQueryStarted?.();

    try {
      for await (const event of persistentSession.runTurn(options, signal)) {
        yield event;
      }
    } catch (err) {
      throw this.normalizeExecutionError(err);
    }
  }

  async compact(sessionId: string): Promise<CompactedContextUsage | undefined> {
    if (!this.lastRunOptions?.trackChildExit) {
      return await this.compactLocked(sessionId);
    }
    const releaseTurn = await this.turnMutex.acquire();
    try {
      return await this.compactLocked(sessionId);
    } finally {
      releaseTurn();
    }
  }

  private async compactLocked(sessionId: string): Promise<CompactedContextUsage | undefined> {
    return await compactClaudeSdkSession(sessionId, this.compactContext);
  }

  sendControlFrame(frame: RunnerControlFrame): boolean {
    return this.runtimeControls.sendControlFrame(frame);
  }

  persistentRuntimeActivity(): ClaudePersistentRuntimeActivity | null {
    return this.runtimeControls.persistentRuntimeActivity();
  }

  injectAtToolBoundary(input: EngineUserInput): boolean {
    return this.runtimeControls.injectAtToolBoundary(input);
  }

  async backgroundClaudeRuntimeTasks(
    toolUseId?: string,
  ): Promise<ClaudeBackgroundTaskControlResult> {
    return await this.runtimeControls.backgroundClaudeRuntimeTasks(toolUseId);
  }

  async stopClaudeRuntimeTask(taskId: string): Promise<ClaudeBackgroundTaskControlResult> {
    return await this.runtimeControls.stopClaudeRuntimeTask(taskId);
  }

  async interrupt(): Promise<boolean> {
    return await this.runtimeControls.interrupt();
  }

  async interruptActiveTurnForSteer(): Promise<boolean> {
    return await this.runtimeControls.interruptActiveTurnForSteer();
  }

  async close(
    reason: import("./claude_session_runtime.js").ClaudeRuntimeCloseReason = "shutdown",
  ): Promise<void> {
    if (this.persistentSession) {
      const persistent = this.persistentSession;
      await this.closePersistentAndSettle(persistent, reason);
      this.toolPermissionController.abortPendingInputRequests();
      this.persistentSession = null;
    }
    this.closeActiveInput();
    this.activeQuery?.close();
    this.toolPermissionController.abortPendingInputRequests();
    if (this.lastRunOptions?.trackChildExit) {
      await this.activeQueryPump?.catch(() => undefined);
    }
    await this.waitForChildExit();
    await this.accountQuerySettlement.settle();
  }

  private async closePersistentAndSettle(
    persistent: ClaudeSdkPersistentSession,
    reason: import("./claude_session_runtime.js").ClaudeRuntimeCloseReason,
  ): Promise<void> {
    await persistent.close(reason);
    await persistent.settled();
    await this.waitForChildExit();
    await this.accountQuerySettlement.settle();
    if (this.persistentSession === persistent) this.persistentSession = null;
    this.persistentConfigDir = null;
    this.persistentConfigDirKnown = false;
  }

  private trackChildExit(closed: Promise<void>): void {
    let tracked!: Promise<void>;
    tracked = closed.finally(() => this.childExitPromises.delete(tracked));
    this.childExitPromises.add(tracked);
  }

  private async waitForChildExit(): Promise<void> {
    while (this.childExitPromises.size > 0) {
      await Promise.all([...this.childExitPromises]);
    }
  }

  private isQueryActive(query: ClaudeSdkQuery): boolean {
    return this.activeQuery === query;
  }

  private normalizeExecutionError(err: unknown, executablePath?: string): Error {
    const rawMessage = err instanceof Error ? err.message : String(err);
    if (isMissingSpawnExecutableError(err) && executablePath) {
      return new Error(
        `Claude Code executable failed to start at CLAUDE_CODE_EXECPATH: ${rawMessage}`,
      );
    }
    if (isMissingSpawnExecutableError(err)) {
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
