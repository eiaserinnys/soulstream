import type { Logger } from "pino";

import {
  mapClaudeClientEvent,
  type ClaudeClientEvent,
} from "../engine/claude_event_mapper.js";
import {
  isPostResultDrainEvent,
  markPostResultDrainEvent,
} from "../engine/claude_event_phase.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { TaskEngineEventPublisher } from "../task/task_engine_event_publisher.js";
import type { Task } from "../task/task_models.js";

interface DetachedClaudeEventBridgeOptions {
  logger: Logger;
  findTask(sessionId: string): Task | undefined;
  getPublisher(): Pick<TaskEngineEventPublisher, "publishEngineEvent"> | undefined;
  collectDetached(task: Task, payload: SSEEventPayload): Promise<void>;
}

/** Maps child-owned Claude lifecycle events back onto the existing host publisher path. */
export function createDetachedClaudeEventBridge(
  options: DetachedClaudeEventBridgeOptions,
): (sessionId: string, event: ClaudeClientEvent, idempotencyKey?: string) => Promise<void> {
  return async (sessionId, event, idempotencyKey) => {
    const task = options.findTask(sessionId);
    const publisher = options.getPublisher();
    if (!task || !publisher) {
      options.logger.warn(
        { sessionId, eventType: event.type },
        "Detached Claude runtime event has no in-memory task",
      );
      return;
    }
    for (const [index, payload] of mapClaudeClientEvent(event).entries()) {
      if (idempotencyKey) {
        (payload as Record<string, unknown>)._dedupe_key = `${idempotencyKey}:${index}`;
      }
      if (isPostResultDrainEvent(event)) markPostResultDrainEvent(payload);
      await publisher.publishEngineEvent(task, payload);
      await options.collectDetached(task, payload);
    }
  };
}
