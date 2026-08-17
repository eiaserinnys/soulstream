import { randomUUID } from "node:crypto";

import type {
  Query as ClaudeSdkQuery,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";
import type { ClaudeRunOptions } from "./claude_adapter.js";
import { markPostResultDrainEvent } from "./claude_event_phase.js";
import type { ClaudeClientEvent } from "./claude_event_mapper.js";
import {
  isTerminalPersistentBackgroundEvent,
  observePersistentBackgroundEvent,
  terminalizePersistentBackgroundTasks,
} from "./claude_persistent_background_lifecycle.js";
import { createEventQueue, type EventQueue } from "./claude_sdk_event_queue.js";
import { ClaudeSdkEventMapper } from "./claude_sdk_event_mapper.js";
import { asRecord, asString } from "./claude_sdk_helpers.js";
import * as rateLimit from "./claude_sdk_rate_limit_stop_failure.js";
import { isFatalClientError, isRuntimeClientEvent } from "./claude_sdk_runtime_state.js";
import { makeUserMessage } from "./claude_sdk_user_message.js";
import { ClaudeRuntimeFollowupWatchdog } from "./claude_runtime_followup_watchdog.js";
import {
  type ActiveForeground,
  type ClaudeDetachedEventSink,
  type ClaudeRuntimeEventSink,
  type ClaudeSdkPersistentSessionConfig,
  describeResultProvenance,
  hashSdkUserMessage,
  isExpectedInterruptDiagnostic,
  turnTimeoutError,
} from "./claude_sdk_persistent_session_support.js";
import {
  ClaudeSessionRuntime,
  type ClaudeForegroundPhase,
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
  private readonly postResultDrainMs: number;
  private readonly turnTimeoutMs: number;
  private readonly runtimeFollowupNoOutputTimeoutMs: number;
  private readonly pump: Promise<void>;
  private readonly hookPump: Promise<void>;
  private readonly followupWatchdog: ClaudeRuntimeFollowupWatchdog;
  private activeForeground: ActiveForeground | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: ClaudeSdkPersistentSessionConfig) {
    this.eventMapper = config.eventMapper;
    this.hookOutput = config.hookOutput;
    this.detachedEventSink = config.detachedEventSink;
    this.runtimeEventSink = config.runtimeEventSink;
    this.logger = config.logger;
    this.postResultDrainMs = config.postResultDrainMs;
    this.turnTimeoutMs = config.turnTimeoutMs;
    this.runtimeFollowupNoOutputTimeoutMs = config.runtimeFollowupNoOutputTimeoutMs;
    this.runtime = new ClaudeSessionRuntime((input) => config.createQuery(input));
    this.followupWatchdog = new ClaudeRuntimeFollowupWatchdog({
      timeoutMs: this.runtimeFollowupNoOutputTimeoutMs,
      resultWaitMs: this.postResultDrainMs,
      logger: this.logger,
      interrupt: async (uuid) => {
        const active = this.activeForeground;
        if (!active || active.uuid !== uuid) return {};
        return this.runtime.snapshot().foregroundPhase === "generating"
          ? await this.runtime.interruptForeground()
          : {};
      },
      close: async (uuid) => {
        const active = this.activeForeground;
        if (!active || active.uuid !== uuid) return;
        // Close the runtime lifecycle before releasing the foreground caller.
        // The caller can start its next turn as soon as this output closes, so
        // publishing the no-op first would let it reuse a Query that is only
        // beginning to close.
        await this.close("followup_no_output");
      },
    });
    this.pump = this.pumpQuery(config.onClosed);
    this.hookPump = this.pumpHookEvents();
  }

  runTurn(options: ClaudeRunOptions, signal: AbortSignal): AsyncIterable<ClaudeClientEvent> {
    if (!options.agentSessionId) {
      throw new Error("Persistent Claude runtime requires agentSessionId");
    }
    if (signal.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("Persistent Claude turn aborted before enqueue");
    }
    if (this.activeForeground) {
      throw new Error("Persistent Claude runtime already has an active foreground turn");
    }

    const output = createEventQueue<ClaudeClientEvent>();
    const uuid = options.inputUuid ?? randomUUID();
    const message = makeUserMessage(
      options.prompt,
      options.imageAttachmentPaths,
      {
        uuid,
        priority: this.runtime.snapshot().foregroundPhase === "idle" ? "now" : "next",
      },
    );
    this.runtime.enqueueInput({
      uuid,
      payloadHash: hashSdkUserMessage(message),
      message,
    });
    const deadlineTimer = setTimeout(() => {
      void this.handleTurnTimeout(uuid);
    }, this.turnTimeoutMs);
    deadlineTimer.unref?.();
    const origin = {
      kind: options.turnOrigin?.kind ?? "initial_prompt",
      id: options.turnOrigin?.id ?? uuid,
    };
    this.activeForeground = {
      uuid,
      output,
      deadlineTimer,
      interruptResultTimer: null,
      timedOut: false,
      origin,
      rateLimitTerminationState: "none",
    };
    if (origin.kind === "runtime_followup") {
      this.followupWatchdog.arm(uuid, origin);
    }
    this.runtime.beginForegroundTurn(uuid);
    this.logger.info(
      { uuid, turnOriginKind: origin.kind, turnOriginId: origin.id },
      "Persistent Claude foreground turn started",
    );
    return output;
  }

  async interruptForeground(): Promise<boolean> {
    if (this.runtime.snapshot().foregroundPhase !== "generating") return false;
    await this.runtime.interruptForeground();
    return true;
  }

  phase(): ClaudeForegroundPhase {
    return this.runtime.snapshot().foregroundPhase;
  }

  snapshot(): ClaudeSessionRuntimeSnapshot {
    return this.runtime.snapshot();
  }

  query(): ClaudeSdkQuery {
    return this.runtime.query as ClaudeSdkQuery;
  }

  async close(reason: ClaudeRuntimeCloseReason): Promise<void> {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    await terminalizePersistentBackgroundTasks({
      runtime: this.runtime,
      reason,
      routeEvent: (event) => this.routeEvent(event),
      logger: this.logger,
    });
    this.runtime.close(reason);
    this.clearForegroundTimers(this.activeForeground);
    this.activeForeground?.output.close();
    this.activeForeground = null;
    this.hookOutput.close();
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
        await this.emitDetached({
          type: "error",
          fatal: true,
          errorCode: "claude_persistent_query_ended",
          message: "Persistent Claude SDK Query ended without an explicit close.",
        });
        await this.close("fatal");
      }
    } catch (err) {
      const active = this.activeForeground;
      active?.output.fail(err);
      this.clearForegroundTimers(active);
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
    if (raw?.type === "result") {
      await this.handleResult(raw);
      return;
    }
    for (const event of this.eventMapper.mapSdkMessage(message)) {
      await this.routeEvent(event);
      if (event.type === "session") this.runtime.setSessionId(event.sessionId);
      if (isFatalClientError(event)) {
        const active = this.activeForeground;
        active?.output.close();
        this.clearForegroundTimers(active);
        this.activeForeground = null;
        await this.close("fatal");
      }
    }
  }

  private async handleResult(message: Record<string, unknown>): Promise<void> {
    const phase = this.runtime.snapshot().foregroundPhase;
    const active = this.activeForeground;
    const explicitUserMessageUuid =
      asString(message.user_message_uuid)
      ?? this.provableTurnResultOwner(phase, active, message);
    if (!explicitUserMessageUuid) {
      // The Query runs turns this session never enqueued. A finished background
      // task makes the harness run its own notification turn, and that turn's
      // terminal Result carries no correlation. Nothing local owns it, so it
      // ends no local turn — and it is not a defect worth ending the session
      // over either.
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
    if (
      (!active || explicitUserMessageUuid !== active.uuid)
    ) {
      const observation = this.runtime.observeDetachedResult(explicitUserMessageUuid);
      if (observation === "duplicate") return;
      if (observation === "unknown") {
        // The Result names a turn this session never enqueued. Unlike a bare
        // Result that is a normal harness event, a named one that misses the
        // ledger is a correlation this session cannot account for. It stays
        // loud and non-fatal: a resumed Query can replay a Result from before
        // this process, and killing the session over that would recreate the
        // defect this path removes.
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
      for (const event of this.eventMapper.mapResultMessage(message)) {
        markPostResultDrainEvent(event);
        await this.emitDetached(event);
      }
      return;
    }

    this.runtime.observeResult({
      userMessageUuid: explicitUserMessageUuid,
      interrupted: phase === "interrupting",
    });
    const followupNoOutput = active
      ? this.followupWatchdog.resultArrived(active.uuid)
      : false;
    this.clearForegroundTimers(active);
    this.runtime.finishForegroundResult();
    this.armDrainTimer();

    if (active && followupNoOutput) {
      this.logger.info(
        {
          uuid: active.uuid,
          turnOriginKind: active.origin.kind,
          turnOriginId: active.origin.id,
        },
        "Runtime follow-up ended as a non-fatal no-op after watchdog interrupt",
      );
    } else if (active?.timedOut) {
      active.output.push(turnTimeoutError(this.turnTimeoutMs));
    } else {
      const terminalEvents = this.eventMapper.mapResultMessage(message);
      for (const event of terminalEvents) {
        if (phase === "interrupting" && isExpectedInterruptDiagnostic(event)) continue;
        if (active) {
          active.output.push(event);
        } else {
          await this.emitDetached(event);
        }
      }
    }
    active?.output.close();
    if (this.activeForeground === active) this.activeForeground = null;
  }

  private async routeEvent(event: ClaudeClientEvent): Promise<void> {
    const runtimeEventAccepted =
      !this.runtimeEventSink || await this.runtimeEventSink(event) !== false;
    if (runtimeEventAccepted || isTerminalPersistentBackgroundEvent(event)) {
      observePersistentBackgroundEvent(this.runtime, event);
    }
    if (!runtimeEventAccepted) {
      return;
    }
    const active = this.activeForeground;
    if (active) this.followupWatchdog.observeProgress(active.uuid, event);
    if (active) {
      active.rateLimitTerminationState =
        rateLimit.observeTerminationSignal(active.rateLimitTerminationState, event);
    }
    if (active?.rateLimitTerminationState === "terminal") {
      active.output.push(event);
      this.runtime.observeResult({ userMessageUuid: active.uuid, interrupted: false });
      this.clearForegroundTimers(active);
      this.runtime.finishForegroundResult();
      this.armDrainTimer();
      active.output.push(rateLimit.makeStopFailureError());
      active.output.close();
      if (this.activeForeground === active) this.activeForeground = null;
      return;
    }
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

  /**
   * Names the turn that owns a Result arriving without `user_message_uuid`.
   *
   * Bare Results also terminate SDK-owned background notification turns, so an
   * outstanding local input is not enough to claim one. Ownership is provable
   * only while this session is interrupting its sole foreground turn: SDK
   * 0.3.218 strips correlation from that abort Result. All other bare Results
   * stay detached; the normal deadline bounds a genuinely missing local Result.
   */
  private provableTurnResultOwner(
    phase: ClaudeForegroundPhase,
    active: ActiveForeground | null,
    message: Record<string, unknown>,
  ): string | null {
    if (phase !== "interrupting" || !active) return null;
    if (asString(asRecord(message.origin)?.kind) === "task-notification") {
      return null;
    }
    this.logger.info(
      { activeForegroundUuid: active.uuid, resultUuid: asString(message.uuid) },
      "Correlating Claude Result without user_message_uuid to the interrupted turn",
    );
    return active.uuid;
  }

  private async handleTurnTimeout(uuid: string): Promise<void> {
    const active = this.activeForeground;
    if (!active || active.uuid !== uuid || active.timedOut) return;
    active.timedOut = true;
    this.logger.warn(
      {
        uuid,
        turnOriginKind: active.origin.kind,
        turnOriginId: active.origin.id,
        timeoutMs: this.turnTimeoutMs,
      },
      "Persistent Claude foreground turn timed out",
    );
    try {
      if (this.runtime.snapshot().foregroundPhase === "generating") {
        await this.runtime.interruptForeground();
      }
      active.interruptResultTimer = setTimeout(() => {
        void this.handleTimedOutTurnWithoutResult(uuid);
      }, this.postResultDrainMs);
      active.interruptResultTimer.unref?.();
    } catch (err) {
      this.logger.warn({ err, uuid }, "Persistent Claude turn timeout interrupt failed");
      active.output.push(turnTimeoutError(this.turnTimeoutMs));
      active.output.close();
      this.clearForegroundTimers(active);
      this.activeForeground = null;
      await this.close("fatal");
    }
  }

  private async handleTimedOutTurnWithoutResult(uuid: string): Promise<void> {
    const active = this.activeForeground;
    if (!active || active.uuid !== uuid || !active.timedOut) return;
    active.output.push(turnTimeoutError(this.turnTimeoutMs));
    active.output.close();
    this.clearForegroundTimers(active);
    this.activeForeground = null;
    await this.close("fatal");
  }

  private clearForegroundTimers(active: ActiveForeground | null): void {
    if (!active) return;
    clearTimeout(active.deadlineTimer);
    this.followupWatchdog.clear(active.uuid);
    if (active.interruptResultTimer) {
      clearTimeout(active.interruptResultTimer);
      active.interruptResultTimer = null;
    }
  }

  private armDrainTimer(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      try {
        this.runtime.finishDrain();
      } catch (err) {
        this.logger.warn({ err }, "Persistent Claude drain phase finalization failed");
      }
    }, this.postResultDrainMs);
  }
}

/**
 * Names where a Result came from, so a bare one can be told apart in the log.
 *
 * `origin` distinguishes a harness turn (`task-notification`) from a
 * human-authored one, and `subtype` distinguishes an error terminal from a
 * successful one. Neither is load-bearing for ownership: `origin` is absent on
 * `SDKResultError`, so absence is not evidence of anything.
 */
