import type { Logger } from "pino";

import type { AgentRegistry } from "../agent_registry.js";
import type { ExecutionContextBuilder } from "../context/context_builder.js";
import type { EventPersistence } from "../db/event_persistence.js";
import type { SessionDB } from "../db/session_db.js";
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
 * caller metadata promotion -> task state transition -> DB status update ->
 * session_updated -> executor resume callback. The executor's initial-message
 * publisher owns the user_message/system_message event path.
 */
export class AutoResumeTransition {
  constructor(private readonly deps: AutoResumeTransitionDeps) {}

  async resume(
    task: Task,
    message: InterventionMessage,
    onResume: AutoResumeCallback,
  ): Promise<{ autoResumed: true }> {
    await this.awaitExecutionDrain(task);
    await this.closeStaleEngine(task);
    await this.promoteCallerInfo(task, message.callerInfo);

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
    } finally {
      task.executionPromise = undefined;
    }
  }

  private async closeStaleEngine(task: Task): Promise<void> {
    if (!task.engine) return;
    const engine = task.engine;
    task.engine = undefined;
    try {
      await engine.close();
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "stale engine close failed before auto-resume",
      );
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

function transitionTaskToRunning(task: Task, message: InterventionMessage): void {
  task.prompt = message.text;
  task.clientId = message.user;
  if (message.callerInfo !== undefined) {
    task.callerInfo = message.callerInfo;
  }
  task.attachmentPaths = message.attachmentPaths ?? [];
  task.contextItems = message.context ?? [];
  task.status = "running";
  task.completedAt = undefined;
  task.error = undefined;
  task.result = undefined;
  task.interventionQueue.push(message);
}
