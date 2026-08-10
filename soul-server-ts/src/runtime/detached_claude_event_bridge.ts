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
): (sessionId: string, event: ClaudeClientEvent) => Promise<void> {
  return async (sessionId, event) => {
    const task = options.findTask(sessionId);
    const publisher = options.getPublisher();
    if (!task || !publisher) {
      options.logger.warn(
        { sessionId, eventType: event.type },
        "Detached Claude runtime event has no in-memory task",
      );
      return;
    }
    for (const payload of mapClaudeClientEvent(event)) {
      if (isPostResultDrainEvent(event)) markPostResultDrainEvent(payload);
      await publisher.publishEngineEvent(task, payload);
      await options.collectDetached(task, payload);
    }
  };
}
