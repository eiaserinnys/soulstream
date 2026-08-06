import type { Logger } from "pino";

import {
  clearEventPersistenceInternals,
  shouldPersistEvent,
  type EventPersistence,
} from "../db/event_persistence.js";
import type { SessionDB } from "../db/session_db.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import { applyClaudeRuntimeEvent } from "./claude_runtime_state.js";
import type { Task } from "./task_models.js";
import { recordTerminationHint } from "./task_termination.js";

export interface TaskEngineEventPublisherDeps {
  broadcaster: SessionBroadcaster;
  db: SessionDB;
  logger: Logger;
  persistence: EventPersistence;
}

/**
 * Owns engine-yielded timeline event publication.
 *
 * Initial user/system events, intervention events, and response-resolution events
 * have separate publishers. This class only handles events yielded by EnginePort.
 */
export class TaskEngineEventPublisher {
  constructor(private readonly deps: TaskEngineEventPublisherDeps) {}

  async publishEngineEvent(task: Task, event: SSEEventPayload): Promise<void> {
    const eventType = (event as { type: string }).type;

    await this.captureSessionId(task, event, eventType);
    this.captureClaudeRuntimeState(task, event);
    this.captureCompactReinjectionNeed(task, eventType);
    this.captureTerminationHint(task, event, eventType);
    this.captureFatalEngineError(task, event, eventType);
    const persistent = await this.enqueuePersistentEventIfNeeded(task, event);
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

  private async captureSessionId(
    task: Task,
    event: SSEEventPayload,
    eventType: string,
  ): Promise<void> {
    if (eventType !== "session") return;

    const sid = (event as { session_id?: unknown }).session_id;
    if (typeof sid !== "string" || task.codexThreadId) return;

    task.codexThreadId = sid;
    // F-3B: persist sessions.claude_session_id so node restarts can resume the backend thread.
    try {
      await this.deps.db.setClaudeSessionId(task.agentSessionId, sid);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId, threadId: sid },
        "setClaudeSessionId failed — thread id not persisted",
      );
    }
  }

  private async enqueuePersistentEventIfNeeded(
    task: Task,
    event: SSEEventPayload,
  ): Promise<boolean> {
    if (!shouldPersistEvent(event)) {
      clearEventPersistenceInternals(event);
      return false;
    }

    try {
      await this.deps.persistence.enqueueEvent(task.agentSessionId, event);
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
    // Keep dispatch/completed info logs: production LOG_LEVEL=info uses them to
    // distinguish "emit not called" from silent upstream failure.
    this.deps.logger.info(
      { sessionId: task.agentSessionId, eventType },
      "emitEventEnvelope dispatch",
    );
    try {
      await this.deps.broadcaster.emitEventEnvelope(task.agentSessionId, event);
      this.deps.logger.info(
        { sessionId: task.agentSessionId, eventType },
        "emitEventEnvelope completed",
      );
    } catch (err) {
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
