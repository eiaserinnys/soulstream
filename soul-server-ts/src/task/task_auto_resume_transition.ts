import type { Logger } from "pino";

import type { AgentRegistry } from "../agent_registry.js";
import type { ExecutionContextBuilder } from "../context/context_builder.js";
import type { ContextItem } from "../context/prompt_assembler.js";
import type { EventPersistence } from "../db/event_persistence.js";
import type { SessionDB } from "../db/session_db.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import type { CallerInfo, InterventionMessage, Task } from "./task_models.js";
import { buildCallerInfoMetadataEntry } from "./task_metadata.js";

export type AutoResumeCallback = (task: Task) => void;

export interface AutoResumeTransitionDeps {
  db: SessionDB;
  broadcaster: SessionBroadcaster;
  logger: Logger;
  persistence?: EventPersistence;
  contextBuilder?: ExecutionContextBuilder;
  agentRegistry?: AgentRegistry;
}

/**
 * Terminal task auto-resume transition.
 *
 * Owns the ordered side effects that turn a completed/error/interrupted task
 * back into a running task for the next user turn:
 * caller metadata promotion -> user_message persist/broadcast -> task state
 * transition -> DB status update -> session_updated -> executor resume callback.
 */
export class AutoResumeTransition {
  constructor(private readonly deps: AutoResumeTransitionDeps) {}

  async resume(
    task: Task,
    message: InterventionMessage,
    onResume: AutoResumeCallback,
  ): Promise<{ autoResumed: true }> {
    await this.awaitExecutionDrain(task);
    await this.promoteCallerInfo(task, message.callerInfo);

    const resumeContextItems = await this.buildResumeContextItems(task);
    const userMessageEvent = buildUserMessageEvent(message, resumeContextItems);
    await this.persistUserMessage(task, userMessageEvent);
    await this.broadcastUserMessage(task, userMessageEvent);

    transitionTaskToRunning(task, message);
    await this.updateSessionStatus(task);
    await this.broadcastSessionUpdated(task);

    onResume(task);
    return { autoResumed: true };
  }

  private async awaitExecutionDrain(task: Task): Promise<void> {
    if (!task.executionPromise) return;
    try {
      await task.executionPromise;
    } catch {
      // ignore; finalize has drained.
    }
  }

  private async promoteCallerInfo(
    task: Task,
    callerInfo: CallerInfo | undefined,
  ): Promise<void> {
    const entry = buildCallerInfoMetadataEntry(callerInfo);
    if (!entry) return;
    task.callerInfo = callerInfo;
    task.metadata = [...(task.metadata ?? []), entry];
    try {
      await this.deps.db.appendMetadata(task.agentSessionId, entry);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "caller_info metadata append failed — continuing auto-resume",
      );
    }
  }

  private async buildResumeContextItems(task: Task): Promise<ContextItem[]> {
    const { contextBuilder, agentRegistry } = this.deps;
    if (!contextBuilder || !agentRegistry || !task.profileId) return [];
    const agent = agentRegistry.get(task.profileId);
    if (!agent) return [];

    try {
      return await contextBuilder.buildResumeContextItems(task, agent);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "buildResumeContextItems failed — context 미주입",
      );
      return [];
    }
  }

  private async persistUserMessage(
    task: Task,
    userMessageEvent: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.persistence) return;
    try {
      const eventId = await this.deps.persistence.persistEvent(
        task.agentSessionId,
        userMessageEvent as SSEEventPayload,
      );
      task.lastEventId = eventId;
      userMessageEvent._event_id = eventId;
      await this.deps.persistence.handleSideEffects(
        task.agentSessionId,
        userMessageEvent as SSEEventPayload,
        task,
      );
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "user_message (auto-resume) persistence failed",
      );
    }
  }

  private async broadcastUserMessage(
    task: Task,
    userMessageEvent: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.broadcaster.emitEventEnvelope(
        task.agentSessionId,
        userMessageEvent as SSEEventPayload,
      );
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "user_message (auto-resume) broadcast failed",
      );
    }
  }

  private async updateSessionStatus(task: Task): Promise<void> {
    try {
      await this.deps.db.updateSession(task.agentSessionId, {
        status: "running",
        last_event_id: task.lastEventId,
      });
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "DB updateSession failed in auto-resume",
      );
    }
  }

  private async broadcastSessionUpdated(task: Task): Promise<void> {
    try {
      await this.deps.broadcaster.emitSessionUpdated(task);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "session_updated (auto-resume) broadcast failed",
      );
    }
  }
}

function buildUserMessageEvent(
  message: InterventionMessage,
  resumeContextItems: ContextItem[],
): Record<string, unknown> {
  const userMessageEvent: Record<string, unknown> = {
    type: "user_message",
    user: message.user,
    text: message.text,
    timestamp: Date.now() / 1000,
  };
  if (resumeContextItems.length > 0) {
    userMessageEvent.context = resumeContextItems;
  }
  if (message.callerInfo) {
    userMessageEvent.caller_info = message.callerInfo;
  }
  if (message.attachmentPaths && message.attachmentPaths.length > 0) {
    userMessageEvent.attachments = message.attachmentPaths;
  }
  return userMessageEvent;
}

function transitionTaskToRunning(task: Task, message: InterventionMessage): void {
  task.status = "running";
  task.completedAt = undefined;
  task.error = undefined;
  task.result = undefined;
  task.interventionQueue.push(message);
}
