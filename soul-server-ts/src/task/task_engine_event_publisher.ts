import type { Logger } from "pino";

import {
  extractTimestamp,
  shouldPersistEvent,
  type EventPersistence,
} from "../db/event_persistence.js";
import type { SessionDB, SupervisorRegistryRow } from "../db/session_db.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import { evaluateSupervisorHandover } from "../supervisor/handover_policy.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import { applyClaudeRuntimeEvent } from "./claude_runtime_state.js";
import type { Task } from "./task_models.js";
import { recordTerminationHint } from "./task_termination.js";
import { supervisorUsageDeltaForEvent } from "./supervisor_usage.js";

export interface TaskEngineEventPublisherDeps {
  broadcaster: SessionBroadcaster;
  db: SessionDB;
  logger: Logger;
  persistence: EventPersistence;
  sourceNode?: string;
  supervisorWakeScheduler?: {
    ingest(eventType: string): Promise<{ scheduled: boolean }>;
  };
  supervisorHandoverRunner?: {
    run(registry: SupervisorRegistryRow): Promise<void>;
  };
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
    this.captureTerminationHint(task, event, eventType);
    this.captureFatalEngineError(task, event, eventType);
    const persistedEventId = await this.persistEventIfNeeded(task, event, eventType);
    await this.broadcastEvent(task, event, eventType);
    await this.appendSupervisorEventIfNeeded(task, event, eventType, persistedEventId);
    await this.recordSupervisorUsageDelta(task, event, eventType);
    await this.handleSideEffects(task, event, eventType);
  }

  private captureClaudeRuntimeState(task: Task, event: SSEEventPayload): void {
    applyClaudeRuntimeEvent(task, event);
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

  private async persistEventIfNeeded(
    task: Task,
    event: SSEEventPayload,
    eventType: string,
  ): Promise<number | null> {
    // `_live_only` chunks are generation-time wire events. Persisting them would
    // duplicate the final assistant_message in DB history.
    if (!shouldPersistEvent(event)) return null;

    try {
      const eventId = await this.deps.persistence.persistEvent(
        task.agentSessionId,
        event,
      );
      task.lastEventId = eventId;
      // Ride-along contract: orch SSE extracts event._event_id as the wire id.
      (event as Record<string, unknown>)._event_id = eventId;
      return eventId;
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId, eventType },
        "persistEvent failed",
      );
      return null;
    }
  }

  private async broadcastEvent(
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

  private async appendSupervisorEventIfNeeded(
    task: Task,
    event: SSEEventPayload,
    eventType: string,
    eventId: number | null,
  ): Promise<void> {
    if (!eventId || !this.deps.sourceNode) return;
    try {
      await this.deps.db.appendSupervisorEvent({
        sourceNode: this.deps.sourceNode,
        sourceSessionId: task.agentSessionId,
        sourceEventId: eventId,
        eventType,
        payload: event as unknown as Record<string, unknown>,
        createdAt: extractTimestamp(event) ?? new Date(),
      });
      await this.deps.supervisorWakeScheduler?.ingest(eventType);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId, eventId, eventType },
        "appendSupervisorEvent failed",
      );
    }
  }

  private async recordSupervisorUsageDelta(
    task: Task,
    event: SSEEventPayload,
    eventType: string,
  ): Promise<void> {
    const { tokenDelta, compactionDelta } = supervisorUsageDeltaForEvent(task, event);
    if (tokenDelta <= 0 && compactionDelta <= 0) return;
    if (!task.profileId) return;

    try {
      const registry = await this.deps.db.getSupervisorRegistry(task.profileId);
      if (!registry) return;
      const updatedRegistry = await this.deps.db.recordSupervisorUsageDelta({
        role: task.profileId,
        tokenDelta,
        compactionDelta,
        lastSeenAt: new Date(),
      });
      if (!updatedRegistry) return;
      await this.applySupervisorHandoverState(task, updatedRegistry, eventType);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId, eventType, role: task.profileId },
        "recordSupervisorUsageDelta failed",
      );
    }
  }

  private async applySupervisorHandoverState(
    task: Task,
    registry: Awaited<ReturnType<SessionDB["recordSupervisorUsageDelta"]>>,
    eventType: string,
  ): Promise<void> {
    if (typeof registry.cumulativeTokens !== "number") return;
    const decision = evaluateSupervisorHandover(
      registry,
      {
        idle: eventType === "complete" && task.interventionQueue.length === 0,
        atTurnBoundary: eventType === "complete",
      },
      {
        minIntervalMs: 0,
      },
    );
    if (decision.state === "handover_running" && this.deps.supervisorHandoverRunner) {
      await this.deps.supervisorHandoverRunner.run(registry);
      return;
    }
    const nextState = supervisorPendingState(decision.state, registry.handoverState);
    if (!decision.changed || nextState === registry.handoverState) return;
    await this.deps.db.upsertSupervisorRegistry({
      role: registry.role,
      activeSessionId: registry.activeSessionId,
      epoch: registry.epoch,
      cursorOffset: registry.cursorOffset,
      handoverState: nextState,
      cumulativeTokens: registry.cumulativeTokens,
      compactionCount: registry.compactionCount,
      lastSeenAt: registry.lastSeenAt,
    });
  }
}

function supervisorPendingState(nextState: string, currentState: string): string {
  if (nextState !== "handover_running") return nextState;
  if (currentState === "hard_pending") return "hard_pending";
  if (currentState === "idle_pending") return "idle_pending";
  return "hard_pending";
}
