import type { Logger } from "pino";

import { mapClaudeClientEvent } from "../engine/claude_event_mapper.js";
import type { ClaudeClientEvent } from "../engine/claude_client_event.js";
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
  /**
   * 호스트 재시작 뒤 메모리에 없는 task를 저장소에서 되살린다(R5). 여기서
   * 사건을 버리면 보유했던 백그라운드 결과가 조용히 사라진다.
   */
  loadTask?(sessionId: string): Promise<Task | null | undefined>;
  getPublisher(): Pick<TaskEngineEventPublisher, "publishEngineEvent"> | undefined;
  collectDetached(task: Task, payload: SSEEventPayload): Promise<void>;
  /**
   * 엔진이 치명 오류로 죽었는데 이어 받을 실행이 없을 때 task를 오류로 끝낸다.
   * 사건을 게시한 뒤에 부른다. 없으면 종료 사건이 만들어지지 않는다.
   */
  terminateAfterFatalEngineError?(task: Task, message: string): Promise<void>;
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
    let task = options.findTask(sessionId);
    const publisher = options.getPublisher();
    if (!task && publisher && options.loadTask) {
      try {
        task = (await options.loadTask(sessionId)) ?? undefined;
      } catch (err) {
        options.logger.warn(
          { err, sessionId, eventType: event.type },
          "Detached Claude runtime event task recovery failed",
        );
      }
    }
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
    const fatal = detachedPayloads.find(isFatalErrorPayload);
    if (fatal && options.terminateAfterFatalEngineError) {
      try {
        await options.terminateAfterFatalEngineError(task, fatal.message);
      } catch (err) {
        options.logger.error(
          { err, sessionId },
          "Detached Claude fatal error could not be turned into a termination",
        );
      }
    }
    return async () => {
      for (const payload of detachedPayloads) {
        await options.collectDetached(task, payload);
      }
    };
  };
}

function isFatalErrorPayload(
  payload: SSEEventPayload,
): payload is SSEEventPayload & { type: "error"; fatal: true; message: string } {
  const candidate = payload as { type?: unknown; fatal?: unknown; message?: unknown };
  return candidate.type === "error"
    && candidate.fatal === true
    && typeof candidate.message === "string";
}
