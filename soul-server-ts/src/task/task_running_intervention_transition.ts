import type { Logger } from "pino";

import type { EventPersistence } from "../db/event_persistence.js";
import type {
  LiveTurnSteerStatus,
  SSEEventPayload,
  SupportsLiveTurnSteering,
} from "../engine/protocol.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import { splitAttachmentPaths } from "./attachment_context.js";
import type { InterventionMessage, Task } from "./task_models.js";

export type RunningInterventionResult =
  | { delivered: true }
  | { queued: true; queuePosition: number; liveSteerStatus?: LiveTurnSteerStatus }
  | { deferred: true; liveSteerStatus?: LiveTurnSteerStatus };

export interface RunningInterventionTransitionDeps {
  broadcaster: SessionBroadcaster;
  logger: Logger;
  persistence?: EventPersistence;
}

/**
 * Running task intervention transition.
 *
 * Owns the ordered side effects for a user intervention that arrives while a
 * task is still running: intervention_sent event construction,
 * persistence/broadcast with _event_id ride-along, optional active-turn live
 * steering, then fallback queueing when live steering is unavailable or fails.
 */
export class RunningInterventionTransition {
  constructor(private readonly deps: RunningInterventionTransitionDeps) {}

  async deliver(
    task: Task,
    message: InterventionMessage,
    options: { queueIfUndelivered?: boolean } = {},
  ): Promise<RunningInterventionResult> {
    if (task.interventionQueue.length > 0) {
      if (options.queueIfUndelivered === false) {
        return { deferred: true, liveSteerStatus: "not_accepting_input" };
      }
      const interventionEvent = buildInterventionSentEvent(message);
      await this.persistIntervention(task, interventionEvent);
      await this.broadcastIntervention(task, interventionEvent);
      task.interventionQueue.push(message);
      return {
        queued: true,
        queuePosition: task.interventionQueue.length,
      };
    }

    if (options.queueIfUndelivered === false) {
      const liveSteerStatus = await this.tryLiveSteer(task, message);
      if (liveSteerStatus === "delivered") {
        const interventionEvent = buildInterventionSentEvent(message);
        await this.persistIntervention(task, interventionEvent);
        await this.broadcastIntervention(task, interventionEvent);
        return { delivered: true };
      }
      return {
        deferred: true,
        ...(liveSteerStatus ? { liveSteerStatus } : {}),
      };
    }

    const interventionEvent = buildInterventionSentEvent(message);
    await this.persistIntervention(task, interventionEvent);
    await this.broadcastIntervention(task, interventionEvent);

    const liveSteerStatus = await this.tryLiveSteer(task, message);
    if (liveSteerStatus === "delivered") {
      return { delivered: true };
    }

    task.interventionQueue.push(message);
    return {
      queued: true,
      queuePosition: task.interventionQueue.length,
      ...(liveSteerStatus ? { liveSteerStatus } : {}),
    };
  }

  private async persistIntervention(
    task: Task,
    interventionEvent: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.persistence) return;
    try {
      const eventId = await this.deps.persistence.persistEvent(
        task.agentSessionId,
        interventionEvent as SSEEventPayload,
      );
      task.lastEventId = eventId;
      // ride-along 5자리 — Python `task_executor.py` `_event_id` 정합. orch session_events.py가
      // SSE id로 추출하여 대시보드 tree-placer dedup·순서 보장.
      interventionEvent._event_id = eventId;
      await this.deps.persistence.handleSideEffects(
        task.agentSessionId,
        interventionEvent as SSEEventPayload,
        task,
      );
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "intervention_sent persistence failed",
      );
    }
  }

  private async broadcastIntervention(
    task: Task,
    interventionEvent: Record<string, unknown>,
  ): Promise<void> {
    try {
      // intervention_sent event dict의 정본은 이 transition이다. broadcaster는
      // persistence 후 _event_id가 박힌 dict를 envelope으로만 운반한다.
      await this.deps.broadcaster.emitEventEnvelope(
        task.agentSessionId,
        interventionEvent as SSEEventPayload,
      );
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "intervention_sent broadcast failed",
      );
    }
  }

  private async tryLiveSteer(
    task: Task,
    message: InterventionMessage,
  ): Promise<LiveTurnSteerStatus | undefined> {
    if (!supportsLiveTurnSteering(task.engine)) return undefined;

    try {
      const { imagePaths } = splitAttachmentPaths(message.attachmentPaths);
      const steerResult = await task.engine.steerActiveTurn({
        prompt: message.text,
        ...(imagePaths.length > 0
          ? { imageAttachmentPaths: imagePaths }
          : {}),
      });
      if (steerResult.status === "delivered") {
        return "delivered";
      }
      this.deps.logger.warn(
        {
          sessionId: task.agentSessionId,
          status: steerResult.status,
          message: steerResult.message,
        },
        "live turn steer not delivered — queueing intervention fallback",
      );
      return steerResult.status;
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "live turn steer failed — queueing intervention fallback",
      );
      return "failed";
    }
  }
}

function buildInterventionSentEvent(message: InterventionMessage): Record<string, unknown> {
  const interventionEvent: Record<string, unknown> = {
    type: "intervention_sent",
    user: message.user,
    text: message.text,
    timestamp: Date.now() / 1000,
  };
  if (message.callerInfo) {
    interventionEvent.caller_info = message.callerInfo;
  }
  if (message.attachmentPaths && message.attachmentPaths.length > 0) {
    interventionEvent.attachments = message.attachmentPaths;
  }
  return interventionEvent;
}

function supportsLiveTurnSteering(
  engine: Task["engine"],
): engine is NonNullable<Task["engine"]> & SupportsLiveTurnSteering {
  return Boolean(
    engine &&
      typeof (engine as unknown as Partial<SupportsLiveTurnSteering>).steerActiveTurn ===
        "function",
  );
}
