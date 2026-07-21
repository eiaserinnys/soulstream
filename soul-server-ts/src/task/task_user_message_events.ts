import type { Logger } from "pino";

import { withoutSessionContextSourceMarkers } from "../context/session_context_sources.js";
import type { ContextItem } from "../context/prompt_assembler.js";
import type { EventPersistence } from "../db/event_persistence.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import type { CallerInfo, Task } from "./task_models.js";

export interface UserMessageEventPublisherDeps {
  broadcaster: SessionBroadcaster;
  logger: Logger;
  persistence?: EventPersistence;
}

export interface UserMessageEventInput {
  text: string;
  user?: string;
  callerInfo?: CallerInfo;
  attachmentPaths?: string[];
  contextItems?: ContextItem[];
}

export function buildUserMessageEvent(input: UserMessageEventInput): Record<string, unknown> {
  const contextItems = withoutSessionContextSourceMarkers(input.contextItems);
  const event: Record<string, unknown> = {
    type: "user_message",
    user:
      input.callerInfo?.display_name ??
      input.callerInfo?.user_id ??
      input.user ??
      "unknown",
    text: input.text,
    timestamp: Date.now() / 1000,
  };
  if (input.callerInfo) {
    event.caller_info = input.callerInfo;
  }
  if (input.attachmentPaths && input.attachmentPaths.length > 0) {
    event.attachments = input.attachmentPaths;
  }
  if (contextItems.length > 0) {
    event.context = contextItems;
  }
  return event;
}

export async function persistUserMessageEvent(
  task: Task,
  event: Record<string, unknown>,
  deps: UserMessageEventPublisherDeps,
  options: { failOnError: boolean },
): Promise<void> {
  if (!deps.persistence) return;
  try {
    const eventId = await deps.persistence.persistEvent(
      task.agentSessionId,
      event as SSEEventPayload,
    );
    task.lastEventId = eventId;
    event._event_id = eventId;
  } catch (err) {
    deps.logger.warn(
      { err, sessionId: task.agentSessionId },
      "user_message persistEvent failed",
    );
    if (options.failOnError) throw err;
  }
}

export async function finishUserMessageEvent(
  task: Task,
  event: Record<string, unknown>,
  deps: UserMessageEventPublisherDeps,
): Promise<void> {
  try {
    await deps.broadcaster.emitEventEnvelope(
      task.agentSessionId,
      event as SSEEventPayload,
    );
  } catch (err) {
    deps.logger.warn(
      { err, sessionId: task.agentSessionId },
      "user_message broadcast failed",
    );
  }

  if (!deps.persistence) return;
  try {
    await deps.persistence.handleSideEffects(
      task.agentSessionId,
      event as SSEEventPayload,
      task,
    );
  } catch (err) {
    deps.logger.warn(
      { err, sessionId: task.agentSessionId },
      "user_message handleSideEffects failed",
    );
  }
}
