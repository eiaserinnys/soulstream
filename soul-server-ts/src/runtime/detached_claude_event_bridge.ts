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
): (
  sessionId: string,
  event: ClaudeClientEvent,
  idempotencyKey?: string,
) => Promise<() => Promise<void>> {
  return async (sessionId, event, idempotencyKey) => {
    const trace = (checkpoint: string, fields: Record<string, unknown>): void => {
      options.logger.info(
        { temporaryTrace: "sonnet-native-delivery", checkpoint, ...fields },
        "TEMPORARY Sonnet native delivery trace",
      );
    };
    const task = options.findTask(sessionId);
    const publisher = options.getPublisher();
    if (!task || !publisher) {
      options.logger.warn(
        { sessionId, eventType: event.type },
        "Detached Claude runtime event has no in-memory task",
      );
      return async () => undefined;
    }
    const detachedPayloads: SSEEventPayload[] = [];
    for (const [index, payload] of mapClaudeClientEvent(event).entries()) {
      if (idempotencyKey && !(payload as Record<string, unknown>)._dedupe_key) {
        (payload as Record<string, unknown>)._dedupe_key = `${idempotencyKey}:${index}`;
      }
      if (isPostResultDrainEvent(event)) markPostResultDrainEvent(payload);
      const sdkDedupeKey = (payload as Record<string, unknown>)._dedupe_key;
      await publisher.publishEngineEvent(task, payload);
      if (typeof sdkDedupeKey === "string") {
        (payload as Record<string, unknown>)._dedupe_key = sdkDedupeKey;
      }
      detachedPayloads.push(payload);
    }
    trace("detached-publish-complete", {
        sessionId,
        eventType: event.type,
        payloadTypes: detachedPayloads.map((payload) => payload.type),
        payloadCount: detachedPayloads.length,
    });
    return async () => {
      trace("post-response-collect-begin", {
          sessionId,
          eventType: event.type,
          payloadCount: detachedPayloads.length,
      });
      try {
        for (const [index, payload] of detachedPayloads.entries()) {
          await options.collectDetached(task, payload);
          trace("post-response-payload-collected", {
              sessionId,
              payloadType: payload.type,
              payloadIndex: index,
          });
        }
      } finally {
        trace("post-response-collect-end", {
            sessionId,
            eventType: event.type,
        });
      }
    };
  };
}
