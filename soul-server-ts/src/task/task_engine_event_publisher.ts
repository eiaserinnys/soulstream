import type { Logger } from "pino";

import {
  clearEventPersistenceInternals,
  shouldPersistEvent,
  type EventPersistence,
} from "../db/event_persistence.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import type { EventOutboxSessionEffect } from "../upstream/event_outbox.js";

import { applyClaudeRuntimeEvent } from "./claude_runtime_state.js";
import type { Task } from "./task_models.js";
import { recordTerminationHint } from "./task_termination.js";
import { TransientEventLogAggregator } from "./transient_event_log_aggregator.js";

export interface TaskEngineEventPublisherDeps {
  broadcaster: SessionBroadcaster;
  logger: Logger;
  persistence: EventPersistence;
  transientEventLogAggregator?: TransientEventLogAggregator;
}

/**
 * Owns engine-yielded timeline event publication.
 *
 * Initial user/system events, intervention events, and response-resolution events
 * have separate publishers. This class only handles events yielded by EnginePort.
 */
export class TaskEngineEventPublisher {
  private readonly transientEventLogAggregator: TransientEventLogAggregator;

  constructor(private readonly deps: TaskEngineEventPublisherDeps) {
    this.transientEventLogAggregator = deps.transientEventLogAggregator ??
      new TransientEventLogAggregator(deps.logger);
  }

  async publishEngineEvent(
    task: Task,
    event: SSEEventPayload,
    options: { alreadyPersisted?: boolean } = {},
  ): Promise<void> {
    const eventType = (event as { type: string }).type;

    const sessionEffect = this.captureSessionId(task, event, eventType);
    this.captureClaudeRuntimeState(task, event);
    this.captureCompactReinjectionNeed(task, eventType);
    this.captureTerminationHint(task, event, eventType);
    this.captureFatalEngineError(task, event, eventType);
    const persistent = options.alreadyPersisted && shouldPersistEvent(event)
      ? true
      : await this.enqueuePersistentEventIfNeeded(task, event, sessionEffect);
    if (options.alreadyPersisted) clearEventPersistenceInternals(event);
    if (!persistent) {
      await this.broadcastTransientEvent(task, event, eventType);
    }
    await this.handleSideEffects(task, event, eventType);
  }

  private captureClaudeRuntimeState(task: Task, event: SSEEventPayload): void {
    applyClaudeRuntimeEvent(task, event);
  }

  private captureCompactReinjectionNeed(task: Task, eventType: string): void {
    if (eventType !== "compact") return;
    task.needsFullContextReinjection = true;
  }

  private captureFatalEngineError(task: Task, event: SSEEventPayload, eventType: string): void {
    if (eventType !== "error") return;
    const payload = event as { fatal?: unknown; message?: unknown };
    if (payload.fatal === false) return;
    task.status = "error";
    task.error = typeof payload.message === "string" ? payload.message : "Engine fatal error";
    task.result = undefined;
  }

  private captureTerminationHint(
    task: Task,
    event: SSEEventPayload,
    eventType: string,
  ): void {
    if (eventType === "credential_alert") {
      const detail = (event as { message?: unknown; detail?: unknown }).message ??
        (event as { detail?: unknown }).detail;
      recordTerminationHint(
        task,
        "limit_hit",
        typeof detail === "string" ? detail : "credential_alert",
      );
      return;
    }
    if (eventType !== "error") return;
    const payload = event as { fatal?: unknown; message?: unknown; error_code?: unknown };
    if (payload.fatal === false) return;
    const detail =
      typeof payload.error_code === "string"
        ? payload.error_code
        : typeof payload.message === "string"
          ? payload.message
          : "Engine fatal error";
    recordTerminationHint(task, "error_aborted", detail);
  }

  private captureSessionId(
    task: Task,
    event: SSEEventPayload,
    eventType: string,
  ): EventOutboxSessionEffect | undefined {
    if (eventType !== "session") return undefined;

    const sid = (event as { session_id?: unknown }).session_id;
    if (typeof sid !== "string") return undefined;

    const rolloverFrom = task.pendingClaudeBackendRolloverFrom;
    if (rolloverFrom !== undefined) {
      if (task.codexThreadId !== rolloverFrom) {
        throw new Error("Claude backend rollover predecessor changed before session capture");
      }
      if (sid === rolloverFrom) {
        throw new Error("Claude backend rollover returned the exhausted session ID");
      }
      task.codexThreadId = sid;
      task.pendingClaudeBackendRolloverFrom = undefined;
      return {
        kind: "rotate_backend_session_id",
        expected_backend_session_id: rolloverFrom,
        backend_session_id: sid,
      };
    }

    if (task.codexThreadId) return undefined;

    task.codexThreadId = sid;
    return { kind: "set_backend_session_id", backend_session_id: sid };
  }

  private async enqueuePersistentEventIfNeeded(
    task: Task,
    event: SSEEventPayload,
    effect?: EventOutboxSessionEffect,
  ): Promise<boolean> {
    if (!shouldPersistEvent(event)) {
      clearEventPersistenceInternals(event);
      return false;
    }

    try {
      await this.deps.persistence.enqueueEvent(task.agentSessionId, event, effect);
      return true;
    } finally {
      clearEventPersistenceInternals(event);
    }
  }

  private async broadcastTransientEvent(
    task: Task,
    event: SSEEventPayload,
    eventType: string,
  ): Promise<void> {
    // Production LOG_LEVEL=info still exposes dispatch/completion health, but a
    // process-wide window prevents streaming deltas from writing two log lines
    // per event.
    this.transientEventLogAggregator.recordDispatch(task.agentSessionId);
    try {
      await this.deps.broadcaster.emitEventEnvelope(task.agentSessionId, event);
      this.transientEventLogAggregator.recordCompleted(task.agentSessionId);
    } catch (err) {
      this.transientEventLogAggregator.recordFailed(task.agentSessionId);
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId, eventType },
        "emitEventEnvelope failed",
      );
    }
  }

  private async handleSideEffects(
    task: Task,
    event: SSEEventPayload,
    eventType: string,
  ): Promise<void> {
    try {
      await this.deps.persistence.handleSideEffects(
        task.agentSessionId,
        event,
        task,
      );
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId, eventType },
        "handleSideEffects threw",
      );
    }
  }

}
