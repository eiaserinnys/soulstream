import type { Logger } from "pino";

import type { EventPersistence } from "../db/event_persistence.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import type { InterventionMessage, Task } from "./task_models.js";

export interface InterventionEventPublisherDeps {
  broadcaster: SessionBroadcaster;
  logger: Logger;
  persistence?: EventPersistence;
}

export function buildInterventionSentEvent(
  message: InterventionMessage,
): Record<string, unknown> {
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
  if (message.context && message.context.length > 0) {
    interventionEvent.context = message.context;
  }
  return interventionEvent;
}

export async function publishInterventionSent(
  task: Task,
  message: InterventionMessage,
  deps: InterventionEventPublisherDeps,
): Promise<void> {
  const interventionEvent = buildInterventionSentEvent(message);
  await persistIntervention(task, interventionEvent, deps);
  await broadcastIntervention(task, interventionEvent, deps);
}

async function persistIntervention(
  task: Task,
  interventionEvent: Record<string, unknown>,
  deps: InterventionEventPublisherDeps,
): Promise<void> {
  if (!deps.persistence) return;
  try {
    const eventId = await deps.persistence.persistEvent(
      task.agentSessionId,
      interventionEvent as SSEEventPayload,
    );
    task.lastEventId = eventId;
    interventionEvent._event_id = eventId;
  } catch (err) {
    deps.logger.warn(
      { err, sessionId: task.agentSessionId },
      "intervention_sent persistence failed",
    );
    throw err;
  }

  try {
    await deps.persistence.handleSideEffects(
      task.agentSessionId,
      interventionEvent as SSEEventPayload,
      task,
    );
  } catch (err) {
    deps.logger.warn(
      { err, sessionId: task.agentSessionId },
      "intervention_sent handleSideEffects failed",
    );
  }
}

async function broadcastIntervention(
  task: Task,
  interventionEvent: Record<string, unknown>,
  deps: InterventionEventPublisherDeps,
): Promise<void> {
  try {
    await deps.broadcaster.emitEventEnvelope(
      task.agentSessionId,
      interventionEvent as SSEEventPayload,
    );
  } catch (err) {
    deps.logger.warn(
      { err, sessionId: task.agentSessionId },
      "intervention_sent broadcast failed",
    );
  }
}
