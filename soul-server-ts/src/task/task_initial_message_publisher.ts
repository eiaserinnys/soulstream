import type { Logger } from "pino";

import type { PreparedContext } from "../context/context_builder.js";
import type { EventPersistence } from "../db/event_persistence.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import type { Task } from "./task_models.js";
import {
  buildUserMessageEvent,
  finishUserMessageEvent,
  persistUserMessageEvent,
} from "./task_user_message_events.js";

export interface TaskInitialMessagePublisherDeps {
  broadcaster: SessionBroadcaster;
  logger: Logger;
  persistence: EventPersistence;
}

/**
 * Owns first-turn system/user message event construction and side effects.
 *
 * TaskExecutor keeps first-turn prompt composition. This publisher keeps the
 * Python-parity payload keys and durable ingress for events that enter the
 * timeline before the engine turn starts.
 */
export class TaskInitialMessagePublisher {
  constructor(private readonly deps: TaskInitialMessagePublisherDeps) {}

  async publishInitialMessages(task: Task, ctx?: PreparedContext): Promise<void> {
    if (ctx?.contextManifest) {
      await this.publishContextManifestBestEffort(task, ctx.contextManifest);
    }
    if (ctx?.effectiveSystemPrompt) {
      await this.publishSystemMessage(task, ctx.effectiveSystemPrompt);
    }
    const event = buildUserMessageEvent({
      text: task.prompt,
      callerInfo: task.callerInfo,
      attachmentPaths: task.attachmentPaths,
      contextItems: ctx ? ctx.combinedContextItems : task.contextItems,
    });
    await persistUserMessageEvent(task, event, this.deps);
    await finishUserMessageEvent(task, event, this.deps);
  }

  private async publishContextManifestBestEffort(
    task: Task,
    manifest: NonNullable<PreparedContext["contextManifest"]>,
  ): Promise<void> {
    try {
      const event = {
        type: "context_manifest",
        ...manifest,
      } satisfies SSEEventPayload;
      await this.deps.persistence.enqueueEvent(
        task.agentSessionId,
        event,
      );
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "context_manifest persistence failed — continuing session start",
      );
    }
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
    await this.deps.persistence.enqueueEvent(
      task.agentSessionId,
      event as SSEEventPayload,
    );
  }
}
