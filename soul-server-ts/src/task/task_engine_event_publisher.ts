import type { Logger } from "pino";

import {
  clearEventPersistenceInternals,
  shouldPersistEvent,
  type EventPersistence,
} from "../db/event_persistence.js";
import { isUsageLimitStopErrorCode } from "../engine/usage_limit_stop.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import type { EventOutboxSessionEffect } from "../upstream/event_outbox.js";

import { applyClaudeRuntimeEvent } from "./claude_runtime_state.js";
import type { Task } from "./task_models.js";
import { buildSessionCostMetadataEntry } from "./task_metadata.js";
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
    this.captureRateLimitStopInfo(task, event, eventType);
    this.captureTerminationHint(task, event, eventType);
    const persistent = options.alreadyPersisted && shouldPersistEvent(event)
      ? true
      : await this.enqueuePersistentEventIfNeeded(task, event, sessionEffect);
    if (options.alreadyPersisted) clearEventPersistenceInternals(event);
    await this.captureSessionCost(task, event, eventType);
    if (!persistent) {
      await this.broadcastTransientEvent(task, event, eventType);
    }
    await this.handleSideEffects(task, event, eventType);
  }

  private captureClaudeRuntimeState(task: Task, event: SSEEventPayload): void {
    applyClaudeRuntimeEvent(task, event);
  }

  private async captureSessionCost(
    task: Task,
    event: SSEEventPayload,
    eventType: string,
  ): Promise<void> {
    if (eventType !== "complete") return;
    const usd = (event as { session_cost_usd?: unknown }).session_cost_usd;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return;

    const next = {
      usd,
      partial: (event as { session_cost_partial?: unknown }).session_cost_partial === true,
    };
    if (task.sessionCost?.usd === next.usd && task.sessionCost.partial === next.partial) return;

    task.sessionCost = next;
    const entry = buildSessionCostMetadataEntry(next);
    task.metadata = [
      ...(task.metadata ?? []).filter((item) => item.type !== "session_cost"),
      entry,
    ];
    try {
      await this.deps.persistence.enqueueMetadataEffect(task.agentSessionId, entry, {
        replaceExistingType: "session_cost",
        ...(task.executionRegistration
          ? { registrationId: task.executionRegistration.registrationId }
          : {}),
      });
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId, eventType },
        "session cost metadata persistence failed",
      );
    }
  }

  private captureCompactReinjectionNeed(task: Task, eventType: string): void {
    if (eventType !== "compact") return;
    task.needsFullContextReinjection = true;
  }

  private captureTerminationHint(
    task: Task,
    event: SSEEventPayload,
    eventType: string,
  ): void {
    if (eventType === "credential_alert") {
      const alert = event as {
        status?: unknown;
        message?: unknown;
        detail?: unknown;
      };
      // allowed_warning is observability only. A hard limit is terminalized by
      // the existing rejected + fatal-error contract.
      if (alert.status !== "rejected") return;
      const detail = alert.message ?? alert.detail;
      recordTerminationHint(
        task,
        "limit_hit",
        typeof detail === "string" ? detail : "credential_alert",
      );
    }
  }

  private captureRateLimitStopInfo(
    task: Task,
    event: SSEEventPayload,
    eventType: string,
  ): void {
    if (eventType !== "error") return;
    const error = event as {
      error_code?: unknown;
      rate_limit_type?: unknown;
      resets_at?: unknown;
    };
    if (!isUsageLimitStopErrorCode(error.error_code)) return;

    const rateLimitType = typeof error.rate_limit_type === "string"
      ? error.rate_limit_type
      : undefined;
    const resetsAt = typeof error.resets_at === "string"
      ? error.resets_at
      : undefined;
    task.rateLimitStopInfo = rateLimitType !== undefined || resetsAt !== undefined
      ? {
        ...(rateLimitType !== undefined ? { rateLimitType } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      }
      : undefined;
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
      await this.deps.persistence.enqueueEvent(
        task.agentSessionId,
        event,
        effect,
        task.executionRegistration?.registrationId,
      );
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
