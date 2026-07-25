import { createHash, randomUUID } from "node:crypto";

import type {
  Query as ClaudeSdkQuery,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { ClaudeRunOptions } from "./claude_adapter.js";
import { markPostResultDrainEvent } from "./claude_event_phase.js";
import type { ClaudeClientEvent } from "./claude_event_mapper.js";
import { createEventQueue, type EventQueue } from "./claude_sdk_event_queue.js";
import { ClaudeSdkEventMapper } from "./claude_sdk_event_mapper.js";
import { asRecord, asString } from "./claude_sdk_helpers.js";
import {
  isFatalClientError,
  isRuntimeClientEvent,
} from "./claude_sdk_runtime_state.js";
import { makeUserMessage } from "./claude_sdk_user_message.js";
import {
  ClaudeSessionRuntime,
  type ClaudeForegroundPhase,
  type ClaudeRuntimeCloseReason,
  type ClaudeSessionRuntimeSnapshot,
} from "./claude_session_runtime.js";

export type ClaudeDetachedEventSink = (event: ClaudeClientEvent) => Promise<void>;

export interface ClaudeSdkPersistentSessionConfig {
  createQuery(input: AsyncIterable<SDKUserMessage>): ClaudeSdkQuery;
  eventMapper: ClaudeSdkEventMapper;
  hookOutput: EventQueue<ClaudeClientEvent>;
  detachedEventSink: ClaudeDetachedEventSink;
  logger: Logger;
  postResultDrainMs: number;
  onClosed?(): void;
}

type ActiveForeground = {
  uuid: string;
  output: EventQueue<ClaudeClientEvent>;
};

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
  private readonly logger: Logger;
  private readonly postResultDrainMs: number;
  private readonly pump: Promise<void>;
  private readonly hookPump: Promise<void>;
  private activeForeground: ActiveForeground | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: ClaudeSdkPersistentSessionConfig) {
    this.eventMapper = config.eventMapper;
    this.hookOutput = config.hookOutput;
    this.detachedEventSink = config.detachedEventSink;
    this.logger = config.logger;
    this.postResultDrainMs = config.postResultDrainMs;
    this.runtime = new ClaudeSessionRuntime((input) => config.createQuery(input));
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
    const uuid = randomUUID();
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
    this.activeForeground = { uuid, output };
    this.runtime.beginForegroundTurn(uuid);
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

  close(reason: ClaudeRuntimeCloseReason): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.runtime.close(reason);
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
        this.runtime.close("fatal");
      }
    } catch (err) {
      this.activeForeground?.output.fail(err);
      this.activeForeground = null;
      await this.emitDetached({
        type: "error",
        fatal: true,
        errorCode: "claude_persistent_query_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      this.runtime.close("fatal");
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
        this.activeForeground?.output.close();
        this.activeForeground = null;
        this.runtime.close("fatal");
      }
    }
  }

  private async handleResult(message: Record<string, unknown>): Promise<void> {
    const phase = this.runtime.snapshot().foregroundPhase;
    const active = this.activeForeground;
    const explicitUserMessageUuid = asString(message.user_message_uuid);
    if (!explicitUserMessageUuid) {
      this.logger.warn(
        {
          activeForegroundUuid: active?.uuid,
          phase,
          resultUuid: asString(message.uuid),
        },
        "Ignoring uncorrelated Claude Result without user_message_uuid",
      );
      return;
    }
    if (
      (!active || explicitUserMessageUuid !== active.uuid)
    ) {
      const observation = this.runtime.observeDetachedResult(explicitUserMessageUuid);
      if (observation === "duplicate") return;
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
    this.runtime.finishForegroundResult();
    this.armDrainTimer();

    const terminalEvents = this.eventMapper.mapResultMessage(message);
    for (const event of terminalEvents) {
      if (phase === "interrupting" && isExpectedInterruptDiagnostic(event)) continue;
      if (active) {
        active.output.push(event);
      } else {
        await this.emitDetached(event);
      }
    }
    active?.output.close();
    if (this.activeForeground === active) this.activeForeground = null;
  }

  private async routeEvent(event: ClaudeClientEvent): Promise<void> {
    this.observeBackgroundEvent(event);
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

  private observeBackgroundEvent(event: ClaudeClientEvent): void {
    switch (event.type) {
      case "claude_runtime_task_started":
      case "claude_runtime_task_created":
      case "claude_runtime_task_progress":
        this.runtime.observeBackgroundTask(event.taskId, false);
        return;
      case "claude_runtime_task_completed":
      case "claude_runtime_task_notification":
        this.runtime.observeBackgroundTask(event.taskId, true);
        return;
      case "claude_runtime_task_updated": {
        const status = event.patch.status;
        const terminal =
          status === "completed" ||
          status === "failed" ||
          status === "stopped" ||
          status === "killed";
        this.runtime.observeBackgroundTask(event.taskId, terminal);
        return;
      }
      default:
        return;
    }
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

function isExpectedInterruptDiagnostic(event: ClaudeClientEvent): boolean {
  return (
    event.type === "error" &&
    event.fatal === false &&
    event.errorCode === "error_during_execution"
  );
}

function hashSdkUserMessage(message: SDKUserMessage): string {
  return createHash("sha256").update(JSON.stringify(message)).digest("hex");
}
