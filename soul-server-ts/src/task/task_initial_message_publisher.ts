import type { Logger } from "pino";

import type { PreparedContext } from "../context/context_builder.js";
import type { EventPersistence } from "../db/event_persistence.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import type { Task } from "./task_models.js";

export interface TaskInitialMessagePublisherDeps {
  broadcaster: SessionBroadcaster;
  logger: Logger;
  persistence: EventPersistence;
}

/**
 * Owns first-turn system/user message event construction and side effects.
 *
 * TaskExecutor keeps first-turn prompt composition. This publisher keeps the
 * Python-parity wire payload keys, `_event_id` ride-along, and failure isolation
 * for the events that enter the timeline before the engine turn starts.
 */
export class TaskInitialMessagePublisher {
  constructor(private readonly deps: TaskInitialMessagePublisherDeps) {}

  async publishInitialMessages(task: Task, ctx?: PreparedContext): Promise<void> {
    if (ctx?.effectiveSystemPrompt) {
      await this.publishSystemMessage(task, ctx.effectiveSystemPrompt);
    }
    await this.publishUserMessage(task, ctx);
  }

  private async publishSystemMessage(
    task: Task,
    effectiveSystemPrompt: string,
  ): Promise<void> {
    // Python parity: system_message carries only {type, text}; timestamp is intentionally absent.
    const event: Record<string, unknown> = {
      type: "system_message",
      text: effectiveSystemPrompt,
    };
    try {
      const eventId = await this.deps.persistence.persistEvent(
        task.agentSessionId,
        event as SSEEventPayload,
      );
      task.lastEventId = eventId;
      event._event_id = eventId;
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "system_message persistEvent failed",
      );
    }

    try {
      await this.deps.broadcaster.emitEventEnvelope(
        task.agentSessionId,
        event as SSEEventPayload,
      );
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "system_message broadcast failed",
      );
    }
  }

  private async publishUserMessage(
    task: Task,
    ctx?: PreparedContext,
  ): Promise<void> {
    const event = this.buildUserMessageEvent(task, ctx);
    try {
      const eventId = await this.deps.persistence.persistEvent(
        task.agentSessionId,
        event as SSEEventPayload,
      );
      task.lastEventId = eventId;
      event._event_id = eventId;
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "user_message persistEvent failed",
      );
    }

    try {
      await this.deps.broadcaster.emitEventEnvelope(
        task.agentSessionId,
        event as SSEEventPayload,
      );
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "user_message broadcast failed",
      );
    }

    try {
      await this.deps.persistence.handleSideEffects(
        task.agentSessionId,
        event as SSEEventPayload,
        task,
      );
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "user_message handleSideEffects failed",
      );
    }
  }

  private buildUserMessageEvent(
    task: Task,
    ctx?: PreparedContext,
  ): Record<string, unknown> {
    const event: Record<string, unknown> = {
      type: "user_message",
      user: task.callerInfo?.display_name ?? task.callerInfo?.user_id ?? "unknown",
      text: task.prompt,
      timestamp: Date.now() / 1000,
    };
    if (task.callerInfo) {
      event.caller_info = task.callerInfo;
    }
    if (task.attachmentPaths && task.attachmentPaths.length > 0) {
      event.attachments = task.attachmentPaths;
    }
    if (ctx && ctx.combinedContextItems.length > 0) {
      event.context = ctx.combinedContextItems;
    }
    return event;
  }
}
