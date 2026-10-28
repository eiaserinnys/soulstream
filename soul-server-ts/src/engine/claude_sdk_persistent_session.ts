import type { Query as ClaudeSdkQuery, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";
import type {
  ClaudeAccountRateLimitSwitchRequest,
  ClaudeRunOptions,
} from "./claude_adapter.js";
import { markPostResultDrainEvent } from "./claude_event_phase.js";
import type { EngineUserInput } from "./protocol.js";
import type { ClaudeClientEvent } from "./claude_client_event.js";
import {
  isTerminalPersistentBackgroundEvent,
  observePersistentBackgroundEvent,
  terminalizePersistentBackgroundTasks,
} from "./claude_persistent_background_lifecycle.js";
import type { EventQueue } from "./claude_sdk_event_queue.js";
import { ClaudeSdkEventMapper } from "./claude_sdk_event_mapper.js";
import { ClaudeSdkUsageCarry } from "./claude_sdk_usage_carry.js";
import { asRecord, asString } from "./claude_sdk_helpers.js";
import {
  handleClaudeSdkPersistentRateLimitTermination,
  observeClaudeSdkPersistentAccountSwitch,
} from "./claude_sdk_persistent_rate_limit_event.js";
import { isFatalClientError, isRuntimeClientEvent } from "./claude_sdk_runtime_state.js";
import { ClaudeSdkPersistentTurnTimers } from "./claude_sdk_persistent_turn_timers.js";
import {
  type ActiveForeground,
  ClaudeExactResultCache,
  type ClaudeDetachedEventSink,
  type ClaudeRuntimeEventSink,
  type ClaudeSdkPersistentSessionConfig,
  ClaudePendingNativeNotificationTracker,
  describeResultProvenance,
  isExpectedInterruptDiagnostic,
  isTurnStartingUserInput,
  makeStaleInterruptReceiptLogger,
  provableTurnResultOwner,
  settleInterventionInterrupt,
  shouldFencePostInterruptContinuation,
  turnInactivityError,
} from "./claude_sdk_persistent_session_support.js";
import {
  deferForegroundResultForInjectedInput,
  injectPersistentToolBoundary,
  interruptPersistentForeground,
  observeCommandLifecycleFrame,
} from "./claude_sdk_persistent_intervention.js";
import { startPersistentForegroundTurn } from "./claude_sdk_persistent_turn_handoff.js";
import {
  ClaudeSessionRuntime,
  type ClaudeRuntimeCloseReason,
  type ClaudeSessionRuntimeSnapshot,
} from "./claude_session_runtime.js";
export type {
  ClaudeDetachedEventSink,
  ClaudeRuntimeEventSink,
  ClaudeSdkPersistentSessionConfig,
} from "./claude_sdk_persistent_session_support.js";
/**
 * One long-lived SDK Query for one Soulstream session.
 *
 * Foreground Result closes only the current output queue. Runtime/background
 * events continue through the detached sink while the SDK input and Query stay
 * open for the next foreground turn.
 */
export class ClaudeSdkPersistentSession {
  private readonly runtime: ClaudeSessionRuntime<SDKUserMessage>;
  private readonly eventMapper: ClaudeSdkEventMapper;
  private readonly hookOutput: EventQueue<ClaudeClientEvent>;
  private readonly detachedEventSink: ClaudeDetachedEventSink;
  private readonly runtimeEventSink?: ClaudeRuntimeEventSink;
  private readonly logger: Logger;
  private readonly pump: Promise<void>;
  private readonly hookPump: Promise<void>;
  private readonly turnTimers: ClaudeSdkPersistentTurnTimers;
  private readonly exactResultCache = new ClaudeExactResultCache();
  private readonly usageCarry: ClaudeSdkUsageCarry;
  private readonly accountRateLimitSwitchEnabled: boolean;
  private readonly nativeNotificationTracker: ClaudePendingNativeNotificationTracker;
  private activeForeground: ActiveForeground | null = null;
  private interventionFence: ActiveForeground | null = null;
  private accountRateLimitSwitch: ClaudeAccountRateLimitSwitchRequest | null = null;
  private closeReasonValue: ClaudeRuntimeCloseReason | null = null;
  constructor(config: ClaudeSdkPersistentSessionConfig) {
    this.eventMapper = config.eventMapper;
    this.hookOutput = config.hookOutput;
    this.detachedEventSink = config.detachedEventSink;
    this.runtimeEventSink = config.runtimeEventSink;
    this.accountRateLimitSwitchEnabled = config.accountRateLimitSwitchEnabled === true;
    this.usageCarry = config.usageCarry ?? new ClaudeSdkUsageCarry();
    this.logger = config.logger;
    this.nativeNotificationTracker = new ClaudePendingNativeNotificationTracker({
      noOutputTimeoutMs: config.runtimeFollowupNoOutputTimeoutMs,
      turnInactivityTimeoutMs: config.turnInactivityTimeoutMs,
    });
    this.runtime = new ClaudeSessionRuntime((input) => config.createQuery(input));
    this.turnTimers = new ClaudeSdkPersistentTurnTimers({
      runtime: this.runtime,
      logger: this.logger,
      turnInactivityTimeoutMs: config.turnInactivityTimeoutMs,
      runtimeFollowupNoOutputTimeoutMs: config.runtimeFollowupNoOutputTimeoutMs,
      postResultDrainMs: config.postResultDrainMs,
      getActive: () => this.activeForeground,
      setActive: (active) => { this.activeForeground = active; },
      close: async () => await this.close("fatal"),
    });
    this.pump = this.pumpQuery(config.onClosed);
    this.hookPump = this.pumpHookEvents();
  }

  runTurn(options: ClaudeRunOptions, signal: AbortSignal): AsyncIterable<ClaudeClientEvent> {
    this.interventionFence = null;
    return startPersistentForegroundTurn({
      options,
      signal,
      activeForeground: this.activeForeground,
      runtime: this.runtime,
      turnInactivityWatchdog: this.turnTimers.turnInactivityWatchdog,
      followupWatchdog: this.turnTimers.followupWatchdog,
      logger: this.logger,
      cachedResultForInput: (uuid) => this.exactResultCache.get(uuid),
      setActiveForeground: (active) => {
        this.activeForeground = active;
      },
    });
  }

  async interruptForeground(): Promise<boolean> {
    return await interruptPersistentForeground({
      active: this.activeForeground,
      runtime: this.runtime,
      logger: this.logger,
      clearForegroundTimers: (active) => this.turnTimers.clearForegroundTimers(active),
      setInterventionFence: (active) => { this.interventionFence = active; },
      close: async (reason) => await this.close(reason),
    });
  }

  injectAtToolBoundary(input: EngineUserInput): boolean {
    return injectPersistentToolBoundary({
      input,
      active: this.activeForeground,
      runtime: this.runtime,
      logger: this.logger,
    });
  }

  snapshot(): ClaudeSessionRuntimeSnapshot {
    return this.runtime.snapshot();
  }
  pendingNativeNotificationCount(): number {
    return this.nativeNotificationTracker.pendingCount();
  }

  query(): ClaudeSdkQuery {
    return this.runtime.query as ClaudeSdkQuery;
  }

  takeAccountRateLimitSwitch(): ClaudeAccountRateLimitSwitchRequest | null {
    const result = this.accountRateLimitSwitch;
    this.accountRateLimitSwitch = null;
    return result;
  }

  closeReason(): ClaudeRuntimeCloseReason | null {
    return this.closeReasonValue;
  }

  async close(reason: ClaudeRuntimeCloseReason): Promise<void> {
    if (reason !== "account_switch") await this.flushPendingRateLimitEvents();
    this.closeReasonValue = reason;
    this.turnTimers.clearDrainTimer();
    this.runtime.close(reason);
    this.exactResultCache.clear();
    if (reason !== "account_switch") this.usageCarry.clear();
    this.nativeNotificationTracker.clear();
    const active = this.activeForeground;
    this.turnTimers.clearForegroundTimers(active);
    active?.output.close();
    this.activeForeground = null;
    settleInterventionInterrupt(this.interventionFence ?? active, false);
    this.interventionFence = null;
    this.hookOutput.close();
    await terminalizePersistentBackgroundTasks({
      runtime: this.runtime,
      reason,
      routeEvent: (event) => this.routeEvent(event),
      logger: this.logger,
    });
  }
  async settled(): Promise<void> {
    await Promise.allSettled([this.pump, this.hookPump]);
  }

  private async pumpQuery(onClosed?: () => void): Promise<void> {
    try {
      for await (const message of this.runtime.query as ClaudeSdkQuery) {
        await this.handleSdkMessage(message);
      }
      if (this.runtime.snapshot().queryLifecycle === "open") {
        const error = {
          type: "error",
          fatal: true,
          errorCode: "claude_persistent_query_ended",
          message: "Persistent Claude SDK Query ended without an explicit close.",
        } as const;
        const active = this.activeForeground;
        if (active) active.output.push(error);
        else await this.emitDetached(error);
        await this.close("fatal");
      }
    } catch (err) {
      const active = this.activeForeground;
      this.runtime.close("fatal");
      active?.output.fail(err);
      this.turnTimers.clearForegroundTimers(active);
      settleInterventionInterrupt(active, false);
      this.activeForeground = null;
      await this.emitDetached({
        type: "error",
        fatal: true,
        errorCode: "claude_persistent_query_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      await this.close("fatal");
    } finally {
      this.hookOutput.close();
      onClosed?.();
    }
  }

  private async handleSdkMessage(message: SDKMessage): Promise<void> {
    const raw = asRecord(message);
    this.nativeNotificationTracker.observeSdkMessage(raw);
    if (raw?.type === "command_lifecycle") observeCommandLifecycleFrame(this.runtime, raw);
    const inputUuid = raw?.type === "user" ? asString(raw.uuid) : undefined;
    const inputOriginKind = asString(asRecord(raw?.origin)?.kind);
    if (raw && inputUuid && inputOriginKind && isTurnStartingUserInput(raw)) {
      this.turnTimers.followupWatchdog.observeTurnInput({
        uuid: inputUuid,
        originKind: inputOriginKind,
      });
    }
    if (raw?.type === "result") {
      // Classification and clearing are atomic. handleResult consumes the
      // verdict instead of rereading a mutable last-input slot.
      const foreignTurnEndedBeforeOwn = this.turnTimers.followupWatchdog.observeTurnResult({
        inputUuid: asString(raw.user_message_uuid),
        originKind: asString(asRecord(raw.origin)?.kind),
      });
      await this.handleResult(raw, foreignTurnEndedBeforeOwn);
      return;
    }
    for (const event of this.eventMapper.mapSdkMessage(message)) {
      await this.routeEvent(event);
      if (event.type === "session") this.runtime.setSessionId(event.sessionId);
      if (isFatalClientError(event)) {
        const active = this.activeForeground;
        active?.output.close();
        this.turnTimers.clearForegroundTimers(active);
        settleInterventionInterrupt(active, false);
        this.activeForeground = null;
        await this.close("fatal");
      }
    }
  }

  private async handleResult(
    message: Record<string, unknown>, foreignTurnEndedBeforeOwn: boolean,
  ): Promise<void> {
    if (this.accountRateLimitSwitch) {
      this.usageCarry.absorb(this.exactResultCache.mapAndRecord(message, this.eventMapper, this.runtime));
      return;
    }
    if (this.activeForeground?.rateLimitSwitchGate.hasPendingSignal()) {
      await this.flushPendingRateLimitEvents();
    }
    const phase = this.runtime.snapshot().foregroundPhase;
    const active = this.activeForeground;
    const explicitUserMessageUuid = provableTurnResultOwner(phase, active, message, this.logger);
    if (!explicitUserMessageUuid) {
      const resultOriginKind = asString(asRecord(message.origin)?.kind);
      if (
        active?.origin.kind === "runtime_followup"
        && resultOriginKind === "task-notification"
        && foreignTurnEndedBeforeOwn
      ) {
        this.logger.warn(
          { activeForegroundUuid: active.uuid, phase, ...describeResultProvenance(message) },
          "Recreating persistent Claude Query after a foreign turn blocked a runtime follow-up",
        );
        await this.close("followup_no_output");
        return;
      }
      // A harness-owned turn (e.g. a background-task notification) ends with a
      // Result carrying no correlation: it ends no local turn and is not fatal.
      this.logger.info(
        {
          activeForegroundUuid: active?.uuid,
          phase,
          ...describeResultProvenance(message),
        },
        "Ignoring Claude Result that terminates no local foreground turn",
      );
      return;
    }
    const terminalEvents = this.exactResultCache.mapAndRecord(message, this.eventMapper, this.runtime);
    if (
      active?.interruptedOwnerUuid
      && explicitUserMessageUuid === active.interruptedOwnerUuid
    ) {
      const interruptedOwnerUuid = active.interruptedOwnerUuid;
      this.runtime.observeResult({
        userMessageUuid: interruptedOwnerUuid,
        interrupted: true,
      });
      active.interruptedOwnerUuid = undefined;
      this.runtime.beginForegroundTurn(active.uuid);
      this.turnTimers.turnInactivityWatchdog.arm(active.uuid);
      if (active.origin.kind === "runtime_followup") {
        this.turnTimers.followupWatchdog.arm(active.uuid, active.origin);
      }
      const expectedInterruptDiagnostic = terminalEvents.some(isExpectedInterruptDiagnostic);
      this.logger.info(
        {
          interruptedOwnerUuid,
          interventionUuid: active.uuid,
          errorDuringExecution: expectedInterruptDiagnostic,
          ...describeResultProvenance(message),
        },
        "Fenced the first interrupted-owner Result before accepting the intervention Result",
      );
      for (const event of this.usageCarry.emittable(terminalEvents, expectedInterruptDiagnostic)) {
        markPostResultDrainEvent(event);
        await this.emitDetached(event);
      }
      return;
    }
    const activeOwnsResult = active !== null
      && (explicitUserMessageUuid === active.uuid
        || this.runtime.isForegroundResultOwner(explicitUserMessageUuid));
    if (!activeOwnsResult) {
      const observation = this.runtime.observeDetachedResult(explicitUserMessageUuid);
      if (observation === "duplicate") return;
      if (observation === "unknown") {
        // A named Result missing from the ledger is a correlation this session
        // cannot account for. It stays loud and non-fatal: a resumed Query can
        // replay a Result from before this process, and killing the session
        // over that would recreate the defect this path removes.
        this.logger.warn(
          {
            activeForegroundUuid: active?.uuid,
            phase,
            userMessageUuid: explicitUserMessageUuid,
            ...describeResultProvenance(message),
          },
          "Claude Result names a turn missing from the persistent input ledger",
        );
      }
      for (const event of terminalEvents) {
        markPostResultDrainEvent(event);
        await this.emitDetached(event);
      }
      return;
    }
    if (deferForegroundResultForInjectedInput({
      phase, active, runtime: this.runtime, message, logger: this.logger,
    })) { this.usageCarry.absorb(terminalEvents); return; }

    this.runtime.observeResult({
      userMessageUuid: active.uuid,
      interrupted: phase === "interrupting",
    });
    this.runtime.settleMergedInputs();
    if (active) this.turnTimers.followupWatchdog.resultArrived(active.uuid);
    this.turnTimers.clearForegroundTimers(active);
    this.runtime.finishForegroundResult();
    this.turnTimers.armDrainTimer();

    if (active?.timedOut) {
      active.output.push(turnInactivityError(this.turnTimers.turnInactivityWatchdog.timeoutMs));
    } else {
      const expectedInterruptDiagnostic =
        this.interventionFence === active
        && terminalEvents.some(isExpectedInterruptDiagnostic);
      for (const event of this.usageCarry.emittable(terminalEvents, expectedInterruptDiagnostic)) {
        if (active) {
          active.output.push(event);
        } else {
          await this.emitDetached(event);
        }
      }
    }
    active?.output.close();
    if (this.activeForeground === active) this.activeForeground = null;
    settleInterventionInterrupt(active, true);
  }

  private async routeEvent(event: ClaudeClientEvent, bypassRateLimitGate = false): Promise<void> {
    const queryOpen = this.runtime.snapshot().queryLifecycle === "open";
    const terminalBackground = isTerminalPersistentBackgroundEvent(event);
    if (!queryOpen && !terminalBackground) return;
    const interruptingActive = this.interventionFence;
    if (shouldFencePostInterruptContinuation(interruptingActive, event)) {
      this.logger.warn(
        { uuid: interruptingActive.uuid, eventType: event.type },
        "Suppressing Claude foreground continuation while awaiting its interrupted Result",
      );
      return;
    }
    const active = this.activeForeground;
    if (active && await observeClaudeSdkPersistentAccountSwitch({
      active,
      event,
      accountSwitchEnabled: this.accountRateLimitSwitchEnabled,
      bypassSwitchGate: bypassRateLimitGate,
      runtime: this.runtime,
      setAccountSwitch: (request) => { this.accountRateLimitSwitch = request; },
      close: async (reason) => await this.close(reason),
    })) return;
    const runtimeEventAccepted =
      !this.runtimeEventSink || await this.runtimeEventSink(event) !== false;
    if (runtimeEventAccepted) this.nativeNotificationTracker.observeAcceptedTerminal(event);
    if (runtimeEventAccepted || terminalBackground) {
      observePersistentBackgroundEvent(this.runtime, event);
    }
    if (!runtimeEventAccepted) {
      return;
    }
    if (active && this.turnTimers.followupWatchdog.observesForeignTurn(active.uuid)) {
      await this.emitDetached(event);
      return;
    }
    if (active && handleClaudeSdkPersistentRateLimitTermination({
      active,
      event,
      runtime: this.runtime,
      clearForegroundTimers: (foreground) => this.turnTimers.clearForegroundTimers(foreground),
      finishDrainTimer: () => this.turnTimers.armDrainTimer(),
      isActiveForeground: (foreground) => this.activeForeground === foreground,
      clearActiveForeground: () => { this.activeForeground = null; },
    })) return;
    if (active) this.turnTimers.turnInactivityWatchdog.recordEvent(active.uuid, event);
    if (active) this.turnTimers.followupWatchdog.observeProgress(active.uuid, event);
    const phase = this.runtime.snapshot().foregroundPhase;
    const runtimeEvent = isRuntimeClientEvent(event);
    if (
      event.type === "prompt_suggestion" ||
      !this.activeForeground ||
      (runtimeEvent && phase !== "generating" && phase !== "interrupting")
    ) {
      if (phase === "turn_result" || phase === "drain" || phase === "idle") {
        markPostResultDrainEvent(event);
      }
      await this.emitDetached(event);
      return;
    }
    this.activeForeground.output.push(event);
  }

  private async pumpHookEvents(): Promise<void> {
    try {
      for await (const event of this.hookOutput) {
        await this.routeEvent(event);
      }
    } catch (err) {
      this.logger.warn({ err }, "Persistent Claude hook event pump failed");
    }
  }

  private async flushPendingRateLimitEvents(): Promise<void> {
    const active = this.activeForeground;
    if (!active?.rateLimitSwitchGate.hasPendingSignal()) return;
    for (const event of active.rateLimitSwitchGate.flush()) {
      await this.routeEvent(event, true);
    }
  }

  private async emitDetached(event: ClaudeClientEvent): Promise<void> {
    try {
      await this.detachedEventSink(event);
    } catch (err) {
      this.logger.warn(
        { err, eventType: event.type },
        "Persistent Claude detached event sink failed",
      );
    }
  }

}
