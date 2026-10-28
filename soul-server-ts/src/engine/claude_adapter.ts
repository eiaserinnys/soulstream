import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type {
  SessionStore,
  SessionStoreFlush,
  EffortLevel,
} from "@anthropic-ai/claude-agent-sdk";

import type { ResolvedMcpServer } from "../mcp_config_service.js";
import { sseEventsFromRunnerFrames } from "../runner/engine_event_stream.js";
import {
  DEFAULT_RUNNER_REQUEST_TIMEOUT_MS,
  InProcessRunnerFrameChannel,
} from "../runner/in_process_frame_channel.js";
import {
  engineEventFrame,
  inputResponseControlFrame,
  runnerRequestFrame,
  type RunnerControlFrame,
  type RunnerEventFrame,
} from "../runner/frame_protocol.js";
import { engineEventMetadata } from "./engine_event_metadata.js";
import type {
  BackendId,
  EngineInterventionResult,
  EngineUserInput,
  EngineExecuteParams,
  EnginePort,
  InputResponseDeliveryResult,
  ClaudePermissionMode,
  ClaudeBackgroundTaskControlResult,
  CompactedContextUsage,
  ReasoningEffort,
  TurnOrigin,
  SSEEventPayload,
  SupportsClaudeBackgroundTasks,
  SupportsCompact,
  SupportsInputResponse,
  SupportsToolBoundaryInjection,
} from "./protocol.js";
import { mapClaudeClientEvent } from "./claude_event_mapper.js";
import type { ClaudeClientEvent } from "./claude_client_event.js";
import {
  makeStopFailureError,
  type RateLimitStopInfo,
} from "./claude_sdk_rate_limit_stop_failure.js";
import {
  buildClaudeEnvironment,
  normalizeClaudeModel,
} from "./claude_options.js";
import {
  assertClaudeAccountPoolOverrides,
  buildClaudeAccountPoolEnvironment,
  useLocalClaudeAccountPoolResume,
  type ClaudeAccountTurnPort,
  type ClaudeAccountTurnStatePort,
} from "./claude_account_pool.js";
import { ClaudeSdkClient } from "./claude_sdk_client.js";
import type { ClaudeSessionClientRegistry } from "./claude_session_client_registry.js";
import type { ClaudePersistentRuntimeActivity } from "./claude_session_runtime.js";
import { toClaudeSdkEffort } from "./effort_boundary.js";
import { withScratchWorkspaceEnv } from "./scratch_workspace_env.js";
import { isFableModel } from "../claude_accounts/selector.js";
import type {
  ClaudeAccountScope,
  ClaudeAccountSelectionExhausted,
  ClaudeAccountSelectionResponse,
  ClaudeAccountSelectionResult,
} from "../claude_accounts/types.js";

const ACCOUNT_SWITCH_CONTINUATION_PROMPT =
  "계정 한도로 직전 응답이 끊겼습니다. 이미 끝낸 도구 작업은 반복하지 말고 남은 작업을 이어서 하세요.";

function accountScopeForRateLimit(info: RateLimitStopInfo, model: string): ClaudeAccountScope {
  if (info.rateLimitType === "five_hour" || info.rateLimitType === "seven_day") return "all";
  return isFableModel(model) ? "fable" : "all";
}

function isAccountPoolExhausted(
  selection: ClaudeAccountSelectionResponse,
): selection is ClaudeAccountSelectionExhausted {
  return "pool_exhausted" in selection;
}

export {
  CLAUDE_OAUTH_TOKEN_ENV,
  CLAUDE_PROMPT_SUGGESTION_ENV,
  buildClaudeEnvironment,
  normalizeClaudeModel,
} from "./claude_options.js";
export { ClaudeSdkClient } from "./claude_sdk_client.js";
export type { ClaudeClientEvent } from "./claude_client_event.js";

export interface ClaudeRunOptions {
  agentSessionId?: string;
  prompt: string;
  inputUuid?: string;
  turnOrigin?: TurnOrigin;
  workspaceDir: string;
  imageAttachmentPaths?: string[];
  resumeSessionId?: string;
  model?: string;
  /** Maps to Claude SDK `Options.effort` (wire `output_config.effort`). */
  effort?: EffortLevel;
  systemPrompt?: string;
  /** Python `agents.yaml.allowed_tools` → Claude SDK `ClaudeAgentOptions.allowedTools`. */
  allowedTools?: string[];
  /** Python `agents.yaml.disallowed_tools` → Claude SDK `disallowedTools`. */
  disallowedTools?: string[];
  /** Python `agents.yaml.max_turns` → Claude SDK `maxTurns`. */
  maxTurns?: number;
  /** Python `Task.use_mcp` → SDK mcpServers 로딩 게이트. undefined면 true. */
  useMcp?: boolean;
  /** `mcp_profile`에서 resolve한 서버. undefined면 workspace MCP config 폴백. */
  resolvedMcpServers?: ResolvedMcpServer[];
  /** Node-local privileged MCP listener URL. Required for Soulstream HTTP MCP entries. */
  internalMcpUrl?: string;
  /** Claude Agent SDK permissionMode. undefined면 legacy bypassPermissions. */
  claudePermissionMode?: ClaudePermissionMode;
  /** agents.yaml `claude_auto_memory_enabled` → Claude SDK `settings.autoMemoryEnabled`. undefined면 settings를 싣지 않는다. */
  autoMemoryEnabled?: boolean;
  env?: Record<string, string>;
  runnerRequest?: (
    frame: Extract<RunnerEventFrame, { kind: "request" }>,
  ) => Promise<RunnerControlFrame>;
  sessionStore?: SessionStore;
  sessionStoreFlush?: SessionStoreFlush;
  loadTimeoutMs?: number;
  /** Install the SDK spawn hook on every platform and retain actual child close. */
  trackChildExit?: boolean;
  /** Marks that this account is now attached to a persistent SDK Query. */
  onAccountQueryStarted?: () => void;
  /** Release a pool account only after this Query and its CLI have settled. */
  onAccountQueryClosed?: (
    reason?: import("./claude_session_runtime.js").ClaudeRuntimeCloseReason,
  ) => Promise<void>;
  onAccountRateLimit?: (
    request: ClaudeAccountRateLimitSwitchRequest,
    signal: AbortSignal,
  ) => Promise<ClaudeAccountRateLimitSwitchDecision>;
}

export interface ClaudeAccountRateLimitSwitchRequest {
  info: RateLimitStopInfo;
  sessionId?: string;
  inputUuid: string;
  inputDelivery: "not_sent" | "ambiguous" | "delivered";
}

export type ClaudeAccountRateLimitSwitchDecision =
  | { kind: "switch"; options: Partial<ClaudeRunOptions> }
  | { kind: "exhausted"; resetsAt?: string | null }
  | { kind: "cancelled" };

export interface ClaudeClient {
  run(options: ClaudeRunOptions, signal: AbortSignal): AsyncIterable<ClaudeClientEvent>;
  runPersistent?(
    options: ClaudeRunOptions,
    signal: AbortSignal,
  ): AsyncIterable<ClaudeClientEvent>;
  compact?(sessionId: string): Promise<CompactedContextUsage | undefined>;
  sendControlFrame?(
    frame: RunnerControlFrame,
  ): Promise<boolean> | boolean;
  backgroundClaudeRuntimeTasks?(
    toolUseId?: string,
  ): Promise<ClaudeBackgroundTaskControlResult> | ClaudeBackgroundTaskControlResult;
  stopClaudeRuntimeTask?(
    taskId: string,
  ): Promise<ClaudeBackgroundTaskControlResult> | ClaudeBackgroundTaskControlResult;
  interruptActiveTurnForSteer?(): Promise<boolean>;
  injectAtToolBoundary?(input: EngineUserInput): Promise<boolean> | boolean;
  interrupt?(): Promise<boolean>;
  persistentRuntimeActivity?(): ClaudePersistentRuntimeActivity | null;
  close?(reason?: import("./claude_session_runtime.js").ClaudeRuntimeCloseReason): Promise<void>;
}

export interface ClaudeAdapterConfig {
  workspaceDir: string;
  agentId?: string;
  client?: ClaudeClient;
  processEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  sessionStore?: SessionStore;
  sessionStoreFlush?: SessionStoreFlush;
  loadTimeoutMs?: number;
  trackChildExit?: boolean;
  claudeAccountPoolEnabled?: boolean;
  claudeAccountTurnPort?: ClaudeAccountTurnPort;
  claudeAccountTurnState?: ClaudeAccountTurnStatePort;
  resolvedMcpServers?: ResolvedMcpServer[];
  internalMcpUrl?: string;
  persistentSessionRegistry?: Pick<
    ClaudeSessionClientRegistry,
    "acquire" | "close" | "release" | "reserve"
  > & { acquireAfterClose?: (sessionId: string) => Promise<ClaudeClient> };
}

export class ClaudeEngineAdapter
  implements
    EnginePort,
    SupportsInputResponse,
    SupportsCompact,
    SupportsClaudeBackgroundTasks,
    SupportsToolBoundaryInjection
{
  public readonly backendId: BackendId = "claude";
  public readonly workspaceDir: string;
  public readonly detachedClaudeRuntime: true | undefined;

  private readonly client: ClaudeClient;
  private readonly logger: Logger;
  private readonly agentId?: string;
  private readonly processEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  private readonly sessionStore?: SessionStore;
  private readonly sessionStoreFlush?: SessionStoreFlush;
  private readonly loadTimeoutMs?: number;
  private readonly trackChildExit: boolean;
  private readonly claudeAccountPoolEnabled: boolean;
  private readonly claudeAccountTurnPort?: ClaudeAccountTurnPort;
  private readonly claudeAccountTurnState?: ClaudeAccountTurnStatePort;
  private readonly resolvedMcpServers?: ResolvedMcpServer[];
  private readonly internalMcpUrl?: string;
  private readonly persistentSessionRegistry?: Pick<
    ClaudeSessionClientRegistry,
    "acquire" | "close" | "release" | "reserve"
  > & { acquireAfterClose?: (sessionId: string) => Promise<ClaudeClient> };
  private activeClient: ClaudeClient | null = null;
  private activeExecution: Promise<void> | null = null;
  private persistentSessionId: string | null = null;
  private activeFrameChannel: InProcessRunnerFrameChannel | null = null;
  private currentTurn: AbortController | null = null;
  private currentTurnCompletion: Promise<void> | null = null;
  private currentTurnUsesAccountPool = false;
  private closed = false;
  private readonly inputRequests = new Map<string, "pending" | "responded" | "expired">();

  constructor(config: ClaudeAdapterConfig, logger: Logger) {
    this.workspaceDir = config.workspaceDir;
    this.detachedClaudeRuntime = config.persistentSessionRegistry ? true : undefined;
    this.agentId = config.agentId;
    this.client = config.client ?? new ClaudeSdkClient({}, logger);
    this.processEnv = config.processEnv;
    this.sessionStore = config.sessionStore;
    this.sessionStoreFlush = config.sessionStoreFlush;
    this.loadTimeoutMs = config.loadTimeoutMs;
    this.trackChildExit = config.trackChildExit ?? false;
    this.claudeAccountPoolEnabled = config.claudeAccountPoolEnabled ?? false;
    this.claudeAccountTurnPort = config.claudeAccountTurnPort;
    this.claudeAccountTurnState = config.claudeAccountTurnState;
    this.resolvedMcpServers = config.resolvedMcpServers;
    this.internalMcpUrl = config.internalMcpUrl;
    this.persistentSessionRegistry = config.persistentSessionRegistry;
    this.logger = logger;
  }

  prepareSessionRuntime(agentSessionId: string): void {
    this.persistentSessionRegistry?.reserve(agentSessionId);
  }

  async *execute(params: EngineExecuteParams): AsyncIterable<SSEEventPayload> {
    yield* sseEventsFromRunnerFrames(this.executeFrames(params));
  }

  executeFrames(params: EngineExecuteParams): AsyncIterable<RunnerEventFrame> {
    const channel = new InProcessRunnerFrameChannel();
    channel.start(async () => {
      const execution = this.executeToFrameChannel(params, channel);
      this.activeExecution = execution;
      try {
        await execution;
      } finally {
        if (this.activeExecution === execution) this.activeExecution = null;
      }
    });
    return channel;
  }

  async executeToFrameChannel(
    params: EngineExecuteParams,
    channel: InProcessRunnerFrameChannel,
  ): Promise<void> {
    if (this.closed) {
      throw new Error("ClaudeEngineAdapter.execute called after close()");
    }
    if (this.currentTurn) {
      throw new Error(
        "ClaudeEngineAdapter.execute: concurrent turn not supported — call interrupt()+drain previous turn first",
      );
    }

    if (params.backendSessionRolloverFrom !== undefined) {
      await this.resetPersistentClientForBackendRollover(params.agentSessionId);
    }

    const controller = new AbortController();
    this.currentTurn = controller;
    let resolveCurrentTurnCompletion!: () => void;
    const currentTurnCompletion = new Promise<void>((resolve) => {
      resolveCurrentTurnCompletion = resolve;
    });
    this.currentTurnCompletion = currentTurnCompletion;
    this.currentTurnUsesAccountPool = this.claudeAccountPoolEnabled
      && params.claudeAccountPoolTarget === true;
    this.activeFrameChannel = channel;
    let lastText: string | undefined;
    let accountTurnId: string | undefined;
    let accountSelectionAttempted = false;
    let accountQueryStarted = false;
    let accountQueryClosed = false;
    let terminalQuerySettled = false;
    let maxAccountAttempts = 0;
    let attemptedAccountIds = new Set<string>();
    let selectedAccount: ClaudeAccountSelectionResult | null = null;
    let accountClient: ClaudeClient | null = null;

    try {
      let options = this.buildRunOptions(params, channel, controller.signal);
      const poolTurn = this.currentTurnUsesAccountPool;
      if (poolTurn) {
        const sessionId = params.agentSessionId;
        const model = options.model;
        const accountPort = this.claudeAccountTurnPort;
        if (!sessionId || !model || !accountPort) {
          throw new Error("Claude account pool turn is missing session, model, or account service");
        }
        assertClaudeAccountPoolOverrides(params.extraEnv);
        if (options.env && Object.hasOwn(options.env, "ANTHROPIC_BASE_URL")) {
          throw new Error("Claude account pool does not allow ANTHROPIC_BASE_URL");
        }
        accountClient = await this.resolveClient(sessionId, true);
        this.activeClient = accountClient;
        if (controller.signal.aborted || this.closed) return;
        accountTurnId = await this.resolveAccountTurnId(params);
        if (controller.signal.aborted || this.closed) return;
        const persistedTurn = this.claudeAccountTurnState?.read();
        const sameTurnState = persistedTurn?.turn_id === accountTurnId ? persistedTurn : null;
        if (sameTurnState?.continuation_uuid && sameTurnState.continuation_sent) {
          throw new Error(
            "Claude account pool turn already sent its durable continuation; refusing to replay it",
          );
        }
        attemptedAccountIds = new Set(sameTurnState?.attempted_ids ?? []);
        accountSelectionAttempted = true;
        const initialSelection = await accountPort.select({
          session_id: sessionId,
          turn_id: accountTurnId,
          model,
          exclude_ids: [...attemptedAccountIds],
        });
        if (isAccountPoolExhausted(initialSelection)) {
          if (controller.signal.aborted || this.closed) return;
          const terminal = makeStopFailureError({
            ...(initialSelection.earliest_available_at
              ? { resetsAt: initialSelection.earliest_available_at }
              : {}),
          });
          for (const payload of mapClaudeClientEvent(terminal)) {
            await channel.emit(engineEventFrame(
              { ...payload } as Record<string, unknown>,
              engineEventMetadata(payload),
            ));
          }
          throw new ClaudeClientFatalEventError(terminal.message);
        }
        selectedAccount = initialSelection;
        if (controller.signal.aborted || this.closed) return;
        maxAccountAttempts = attemptedAccountIds.size + selectedAccount.available_count;
        const baseOptions = { ...options };
        let turnState = {
          turn_id: accountTurnId,
          account_id: selectedAccount.account_id,
          attempted_ids: [...attemptedAccountIds],
          continuation_uuid: sameTurnState?.continuation_uuid ?? null,
          continuation_sent: sameTurnState?.continuation_sent ?? false,
        };
        await this.claudeAccountTurnState?.write(turnState);
        if (controller.signal.aborted || this.closed) return;
        const resumePendingContinuation = Boolean(
          sameTurnState?.continuation_uuid && !sameTurnState.continuation_sent,
        );
        if (resumePendingContinuation) {
          options = {
            ...baseOptions,
            prompt: ACCOUNT_SWITCH_CONTINUATION_PROMPT,
            inputUuid: sameTurnState!.continuation_uuid!,
          };
          turnState = { ...turnState, continuation_sent: true };
          await this.claudeAccountTurnState?.write(turnState);
        }

        const bindAccountAttempt = (
          account: ClaudeAccountSelectionResult,
          overrides: Partial<ClaudeRunOptions> = {},
        ): ClaudeRunOptions => {
          accountQueryStarted = false;
          accountQueryClosed = false;
          let queryBindingReleased = false;
          const attemptOptions: ClaudeRunOptions = {
            ...baseOptions,
            ...overrides,
            env: buildClaudeAccountPoolEnvironment(baseOptions.env, account),
            ...(baseOptions.sessionStore
              ? {
                  sessionStore: useLocalClaudeAccountPoolResume(
                    baseOptions.sessionStore,
                    account.config_dir,
                  ),
                }
              : {}),
          };
          attemptOptions.onAccountQueryStarted = () => {
            accountQueryStarted = true;
            accountQueryClosed = false;
          };
          attemptOptions.onAccountQueryClosed = async (reason) => {
            if (queryBindingReleased) return;
            queryBindingReleased = true;
            accountQueryClosed = true;
            if (reason === "account_switch") return;
            terminalQuerySettled = true;
            await accountPort.release({
              session_id: sessionId,
              account_id: account.account_id,
              turn_id: accountTurnId,
            });
            if (accountTurnId) await this.clearAccountTurnIfCurrent(accountTurnId);
          };
          attemptOptions.onAccountRateLimit = async (request, signal) => {
            if (signal.aborted || this.closed) return { kind: "cancelled" };
            const failedAccount = selectedAccount;
            if (!failedAccount) throw new Error("Claude account rate limit has no selected account");
            await accountPort.reject({
              account_id: failedAccount.account_id,
              scope: accountScopeForRateLimit(request.info, model),
              resets_at: request.info.resetsAt ?? null,
              observed_at: new Date().toISOString(),
              session_id: sessionId,
            });
            attemptedAccountIds.add(failedAccount.account_id);
            turnState = {
              turn_id: accountTurnId!,
              account_id: failedAccount.account_id,
              attempted_ids: [...attemptedAccountIds],
              continuation_uuid: null,
              continuation_sent: false,
            };
            await this.claudeAccountTurnState?.write(turnState);

            if (signal.aborted || this.closed) return { kind: "cancelled" };
            if (!request.sessionId && request.inputDelivery !== "not_sent") {
              return {
                kind: "exhausted",
                resetsAt: request.info.resetsAt ?? null,
              };
            }

            const nextAccount = await accountPort.select({
              session_id: sessionId,
              turn_id: accountTurnId!,
              model,
              exclude_ids: [...attemptedAccountIds],
            });
            if (signal.aborted || this.closed) {
              if (!isAccountPoolExhausted(nextAccount)) {
                await accountPort.release({
                  session_id: sessionId,
                  account_id: nextAccount.account_id,
                  turn_id: accountTurnId,
                });
              }
              return { kind: "cancelled" };
            }
            if (isAccountPoolExhausted(nextAccount)) {
              return {
                kind: "exhausted",
                resetsAt: nextAccount.earliest_available_at,
              };
            }
            if (attemptedAccountIds.size >= maxAccountAttempts) {
              await accountPort.release({
                session_id: sessionId,
                account_id: nextAccount.account_id,
                turn_id: accountTurnId,
              });
              return { kind: "exhausted", resetsAt: null };
            }

            selectedAccount = nextAccount;
            let nextOptions: ClaudeRunOptions;
            if (request.sessionId) {
              const stored = this.claudeAccountTurnState?.read();
              const continuationUuid = stored && stored.turn_id === accountTurnId
                && stored.continuation_uuid
                && !stored.continuation_sent
                ? stored.continuation_uuid
                : randomUUID();
              turnState = {
                turn_id: accountTurnId!,
                account_id: nextAccount.account_id,
                attempted_ids: [...attemptedAccountIds],
                continuation_uuid: continuationUuid,
                continuation_sent: false,
              };
              await this.claudeAccountTurnState?.write(turnState);
              turnState = { ...turnState, continuation_sent: true };
              await this.claudeAccountTurnState?.write(turnState);
              nextOptions = bindAccountAttempt(nextAccount, {
                prompt: ACCOUNT_SWITCH_CONTINUATION_PROMPT,
                inputUuid: continuationUuid,
                resumeSessionId: request.sessionId,
              });
            } else {
              turnState = {
                turn_id: accountTurnId!,
                account_id: nextAccount.account_id,
                attempted_ids: [...attemptedAccountIds],
                continuation_uuid: null,
                continuation_sent: false,
              };
              await this.claudeAccountTurnState?.write(turnState);
              const { resumeSessionId: _resumeSessionId, ...withoutResume } = baseOptions;
              nextOptions = bindAccountAttempt(nextAccount, withoutResume);
            }
            return { kind: "switch", options: nextOptions };
          };
          return attemptOptions;
        };

        if (resumePendingContinuation) {
          options = bindAccountAttempt(selectedAccount, {
            prompt: ACCOUNT_SWITCH_CONTINUATION_PROMPT,
            inputUuid: sameTurnState!.continuation_uuid!,
          });
        } else {
          options = bindAccountAttempt(selectedAccount);
        }
      }

      const client = accountClient ?? await this.resolveClient(params.agentSessionId);
      accountClient = client;
      this.activeClient = client;
      const events = this.persistentSessionRegistry
        ? client.runPersistent?.(options, controller.signal)
        : client.run(options, controller.signal);
      if (!events) {
        throw new Error("Persistent Claude client does not implement runPersistent()");
      }
      for await (const clientEvent of events) {
        this.trackInputRequest(clientEvent);

        if (clientEvent.type === "text") {
          lastText = clientEvent.text;
        }

        const payloads = mapClaudeClientEvent(clientEvent, {
          fallbackResult: lastText,
        });
        for (const payload of payloads) {
          await channel.emit(engineEventFrame(
            { ...payload } as Record<string, unknown>,
            engineEventMetadata(payload),
          ));
        }
        if (clientEvent.type === "input_request") {
          await channel.emit(runnerRequestFrame(clientEvent.requestId, {
            kind: "can_use_tool",
            ...(params.agentSessionId ? { agentSessionId: params.agentSessionId } : {}),
            ...(clientEvent.toolUseId ? { toolUseId: clientEvent.toolUseId } : {}),
            toolName: "AskUserQuestion",
            input: { questions: clientEvent.questions },
          }));
        }

        if (clientEvent.type === "error" && clientEvent.fatal !== false) {
          throw new ClaudeClientFatalEventError(clientEvent.message);
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        this.logger.info("Claude turn aborted by interrupt()");
        return;
      }
      if (!(err instanceof ClaudeClientFatalEventError)) {
        this.logger.warn({ err }, "Claude client stream error");
        const payload = {
          type: "error",
          message: err instanceof Error ? err.message : String(err),
          fatal: true,
          timestamp: nowSeconds(),
        } as SSEEventPayload;
        await channel.emit(engineEventFrame(payload as Record<string, unknown>));
      }
      throw err;
    } finally {
      try {
        if (accountSelectionAttempted && params.agentSessionId && this.claudeAccountTurnPort) {
          const queryStillActive = accountQueryStarted && !accountQueryClosed;
          if (selectedAccount && !terminalQuerySettled) {
            await this.claudeAccountTurnPort.release({
              session_id: params.agentSessionId,
              account_id: selectedAccount.account_id,
              ...(accountTurnId ? { turn_id: accountTurnId } : {}),
              ...(queryStillActive ? { keep_query_active: true } : {}),
            });
            if (!queryStillActive && accountTurnId) {
              await this.clearAccountTurnIfCurrent(accountTurnId);
            }
          } else if (!selectedAccount && !accountClient?.persistentRuntimeActivity?.()) {
            await this.claudeAccountTurnPort.release({
              session_id: params.agentSessionId,
            });
          }
        }
      } finally {
        this.currentTurn = null;
        this.currentTurnUsesAccountPool = false;
        this.activeFrameChannel = null;
        if (this.currentTurnCompletion === currentTurnCompletion) {
          this.currentTurnCompletion = null;
        }
        resolveCurrentTurnCompletion();
      }
    }
  }

  async sendControlFrame(frame: RunnerControlFrame): Promise<boolean> {
    if (frame.kind === "response") {
      return this.activeFrameChannel?.sendControl(frame) ?? false;
    }
    const client = this.activeClient ?? this.client;
    return await client.sendControlFrame?.(frame) ?? false;
  }

  async interrupt(): Promise<boolean> {
    if (!this.currentTurn) {
      return false;
    }
    this.currentTurn.abort();
    const client = this.activeClient ?? this.client;
    if (client.interrupt) {
      const interrupted = await client.interrupt();
      if (this.persistentSessionRegistry && this.persistentSessionId) {
        await this.persistentSessionRegistry.close(
          this.persistentSessionId,
          "explicit_cancel",
        );
        this.activeClient = null;
      }
      return interrupted;
    }
    return true;
  }

  async intervene(input: EngineUserInput): Promise<EngineInterventionResult> {
    void input;
    if (!this.currentTurn) {
      return {
        status: "not_delivered",
        mechanism: "interrupt_then_next_turn",
        reason: "no_active_turn",
      };
    }
    const client = this.activeClient ?? this.client;
    const interrupt = client.persistentRuntimeActivity?.() === null
      ? undefined
      : client.interruptActiveTurnForSteer;
    if (!interrupt) {
      return {
        status: "not_delivered",
        mechanism: "unsupported",
        reason: "not_supported",
        message: "Claude client does not support intervention interrupts",
      };
    }
    const currentTurnCompletion = this.currentTurnCompletion;
    const interrupted = await interrupt.call(client);
    if (interrupted) {
      await currentTurnCompletion;
    }
    return interrupted
      ? {
          status: "not_delivered",
          mechanism: "interrupt_then_next_turn",
          reason: "next_turn_required",
        }
      : {
          status: "not_delivered",
          mechanism: "interrupt_then_next_turn",
          reason: "no_active_turn",
        };
  }

  async injectAtToolBoundary(input: EngineUserInput): Promise<EngineInterventionResult> {
    if (!this.currentTurn) {
      return {
        status: "not_delivered",
        mechanism: "active_turn",
        reason: "no_active_turn",
      };
    }
    const client = this.activeClient ?? this.client;
    if (!client.injectAtToolBoundary) {
      return {
        status: "not_delivered",
        mechanism: "unsupported",
        reason: "not_supported",
        message: "Claude client does not support tool-boundary injection",
      };
    }
    const delivered = await client.injectAtToolBoundary(input);
    return delivered
      ? { status: "delivered", mechanism: "active_turn" }
      : {
          status: "not_delivered",
          mechanism: "active_turn",
          reason: "no_active_turn",
        };
  }

  async compact(sessionId: string): Promise<CompactedContextUsage | undefined> {
    if (!sessionId) {
      throw new Error("ClaudeEngineAdapter.compact requires sessionId");
    }
    const client = this.activeClient ?? this.client;
    if (!client.compact) {
      throw new Error("Claude client does not support compact");
    }
    return await client.compact(sessionId);
  }

  async backgroundClaudeRuntimeTasks(
    toolUseId?: string,
  ): Promise<ClaudeBackgroundTaskControlResult> {
    const client = this.activeClient ?? this.client;
    if (!client.backgroundClaudeRuntimeTasks) {
      return {
        status: "not_supported",
        message: "Claude client does not support background task control",
      };
    }
    return await client.backgroundClaudeRuntimeTasks(toolUseId);
  }

  async detachedClaudeRuntimeActivity(): Promise<ClaudePersistentRuntimeActivity | null> {
    const client = this.activeClient ?? this.client;
    return client.persistentRuntimeActivity?.() ?? null;
  }

  async stopClaudeRuntimeTask(taskId: string): Promise<ClaudeBackgroundTaskControlResult> {
    const client = this.activeClient ?? this.client;
    if (!client.stopClaudeRuntimeTask) {
      return {
        status: "not_supported",
        message: "Claude client does not support background task control",
      };
    }
    return await client.stopClaudeRuntimeTask(taskId);
  }

  async deliverInputResponse(
    requestId: string,
    answers: Record<string, unknown>,
  ): Promise<InputResponseDeliveryResult> {
    const current = this.inputRequests.get(requestId);
    if (current === undefined) {
      return { status: "request_not_pending" };
    }
    if (current === "expired") {
      return { status: "expired" };
    }
    if (current === "responded") {
      return { status: "already_responded" };
    }
    const client = this.activeClient ?? this.client;
    if (!client.sendControlFrame) {
      return {
        status: "not_supported",
        message: "Claude client does not support input responses",
      };
    }

    const delivered = await this.sendControlFrame(inputResponseControlFrame(requestId, answers));
    if (!delivered) {
      return { status: "request_not_pending" };
    }
    this.inputRequests.set(requestId, "responded");
    return { status: "delivered" };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.currentTurn) {
      this.currentTurn.abort();
      this.currentTurn = null;
    }
    this.inputRequests.clear();
    if (!this.persistentSessionRegistry) {
      await this.client.close?.();
    } else if (this.persistentSessionId) {
      if (this.claudeAccountPoolEnabled) {
        await this.persistentSessionRegistry.close(this.persistentSessionId, "shutdown");
      } else {
        this.persistentSessionRegistry.release(this.persistentSessionId);
      }
    }
    this.activeClient = null;
    await this.activeExecution?.catch((error) => {
      this.logger.warn({ err: error }, "Claude execution ended during adapter close");
    });
    this.claudeAccountTurnState?.close?.();
  }

  private buildRunOptions(
    params: EngineExecuteParams,
    channel: InProcessRunnerFrameChannel,
    signal: AbortSignal,
  ): ClaudeRunOptions {
    const model = normalizeClaudeModel(params.model);
    const claudeEffort = toClaudeSdkEffort(params.reasoningEffort);
    if (params.reasoningEffort && !claudeEffort) {
      this.logger.warn(
        { model, reasoningEffort: params.reasoningEffort },
        "ClaudeEngineAdapter: effort not expressible for Claude; using backend default",
      );
    }
    const env = withScratchWorkspaceEnv(
      buildClaudeEnvironment({
        processEnv: this.processEnv,
        extraEnv: params.extraEnv,
      }),
      { workspaceDir: this.workspaceDir, agentId: this.agentId },
    );
    return {
      prompt: params.prompt,
      ...(params.inputUuid ? { inputUuid: params.inputUuid } : {}),
      ...(params.turnOrigin ? { turnOrigin: params.turnOrigin } : {}),
      ...(params.agentSessionId ? { agentSessionId: params.agentSessionId } : {}),
      workspaceDir: this.workspaceDir,
      ...(params.imageAttachmentPaths !== undefined
        ? { imageAttachmentPaths: params.imageAttachmentPaths }
        : {}),
      ...(params.resumeSessionId ? { resumeSessionId: params.resumeSessionId } : {}),
      ...(model ? { model } : {}),
      ...(claudeEffort ? { effort: claudeEffort } : {}),
      ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
      ...(params.allowedTools !== undefined ? { allowedTools: params.allowedTools } : {}),
      ...(params.disallowedTools !== undefined ? { disallowedTools: params.disallowedTools } : {}),
      ...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}),
      ...(params.useMcp !== undefined ? { useMcp: params.useMcp } : {}),
      ...(this.resolvedMcpServers !== undefined
        ? { resolvedMcpServers: this.resolvedMcpServers }
        : {}),
      ...(this.internalMcpUrl ? { internalMcpUrl: this.internalMcpUrl } : {}),
      ...(params.claudePermissionMode !== undefined
        ? { claudePermissionMode: params.claudePermissionMode }
        : {}),
      ...(params.claudeAutoMemoryEnabled !== undefined
        ? { autoMemoryEnabled: params.claudeAutoMemoryEnabled }
        : {}),
      env,
      ...(params.scheduleToolUseEnabled && params.agentSessionId
        ? {
            runnerRequest: (frame: Extract<RunnerEventFrame, { kind: "request" }>) =>
              channel.request(frame, {
                signal,
                timeoutMs: frame.timeoutMs ?? DEFAULT_RUNNER_REQUEST_TIMEOUT_MS,
              }),
          }
        : {}),
      ...(this.sessionStore !== undefined ? { sessionStore: this.sessionStore } : {}),
      ...(this.sessionStoreFlush !== undefined ? { sessionStoreFlush: this.sessionStoreFlush } : {}),
      ...(this.loadTimeoutMs !== undefined ? { loadTimeoutMs: this.loadTimeoutMs } : {}),
      ...(this.trackChildExit ? { trackChildExit: true } : {}),
    };
  }

  private async resolveClient(
    agentSessionId: string | undefined,
    afterPreviousClose = false,
  ): Promise<ClaudeClient> {
    if (!this.persistentSessionRegistry) return this.client;
    if (!agentSessionId) {
      throw new Error("Persistent Claude runtime requires agentSessionId");
    }
    if (!afterPreviousClose && this.persistentSessionId === agentSessionId && this.activeClient) {
      return this.activeClient;
    }
    if (
      this.persistentSessionId
      && this.persistentSessionId !== agentSessionId
    ) {
      throw new Error(
        `ClaudeEngineAdapter cannot switch persistent session: ${this.persistentSessionId} -> ${agentSessionId}`,
      );
    }
    const client = afterPreviousClose && this.persistentSessionRegistry.acquireAfterClose
      ? await this.persistentSessionRegistry.acquireAfterClose(agentSessionId)
      : this.persistentSessionRegistry.acquire(agentSessionId);
    this.persistentSessionId = agentSessionId;
    this.activeClient = client;
    return client;
  }

  private async resolveAccountTurnId(params: EngineExecuteParams): Promise<string> {
    const durableInputId = params.inputUuid
      ?? params.runnerInterventionId
      ?? params.runnerInterventionIds?.[0];
    if (durableInputId) return durableInputId;
    return this.claudeAccountTurnState?.read()?.turn_id ?? randomUUID();
  }

  private async clearAccountTurnIfCurrent(turnId: string): Promise<void> {
    const current = this.claudeAccountTurnState?.read();
    if (!current || current.turn_id === turnId) {
      await this.claudeAccountTurnState?.clear(turnId);
    }
  }

  private async resetPersistentClientForBackendRollover(
    agentSessionId: string | undefined,
  ): Promise<void> {
    if (!this.persistentSessionRegistry) return;
    if (!agentSessionId) {
      throw new Error("Persistent Claude backend rollover requires agentSessionId");
    }
    if (this.persistentSessionId && this.persistentSessionId !== agentSessionId) {
      throw new Error(
        `Claude backend rollover session mismatch: ${this.persistentSessionId} -> ${agentSessionId}`,
      );
    }
    await this.persistentSessionRegistry.close(agentSessionId, "backend_rollover");
    this.persistentSessionId = null;
    this.activeClient = null;
    this.inputRequests.clear();
  }

  private trackInputRequest(event: ClaudeClientEvent): void {
    if (event.type === "input_request") {
      if (!this.inputRequests.has(event.requestId)) {
        this.inputRequests.set(event.requestId, "pending");
      }
      return;
    }
    if (event.type === "input_request_responded") {
      this.inputRequests.set(event.requestId, "responded");
      return;
    }
    if (event.type === "input_request_expired") {
      if (this.inputRequests.get(event.requestId) !== "responded") {
        this.inputRequests.set(event.requestId, "expired");
      }
    }
  }
}

class ClaudeClientFatalEventError extends Error {}

function nowSeconds(): number {
  return Date.now() / 1000;
}

export const claudeEngineEventMetadata = engineEventMetadata;
