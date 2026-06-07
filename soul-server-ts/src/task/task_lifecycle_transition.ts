import type { Logger } from "pino";

import type { SessionDB } from "../db/session_db.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import type { Task } from "./task_models.js";
import {
  buildSessionEndedEvent,
  finalizeTaskTermination,
  recordTerminationHint,
} from "./task_termination.js";

export interface ExternalFinalizeParams {
  result?: string;
  error?: string;
  llmUsage?: Record<string, number> | null;
}

interface TaskLifecycleTransitionDeps {
  db: SessionDB;
  broadcaster: SessionBroadcaster;
  logger: Logger;
}

interface FinalStateLogMessages {
  db: string;
  broadcast: string;
}

const EXECUTOR_FINALIZE_LOGS: FinalStateLogMessages = {
  db: "DB updateSession failed in finalize",
  broadcast: "session_updated broadcast failed",
};

const EXTERNAL_FINALIZE_LOGS: FinalStateLogMessages = {
  db: "DB updateSession failed in finalizeTask",
  broadcast: "session_updated broadcast failed in finalizeTask",
};

const SHUTDOWN_INTERRUPT_LOGS: FinalStateLogMessages = {
  db: "DB updateSession failed during shutdown interrupt",
  broadcast: "session_updated broadcast failed during shutdown interrupt",
};

export class TaskLifecycleTransition {
  constructor(private readonly deps: TaskLifecycleTransitionDeps) {}

  async cancelRunningTask(task: Task | undefined): Promise<boolean> {
    if (!task) return false;
    if (task.status !== "running") return false;
    if (!task.engine) return false;

    task.status = "interrupted";
    recordTerminationHint(task, "killed", "cancelled");
    return await task.engine.interrupt();
  }

  async interruptAndDrain(task: Task): Promise<void> {
    if (!task.engine) return;

    try {
      await task.engine.interrupt();
    } catch {
      // interrupt is idempotent; cleanup must continue.
    }
    if (task.executionPromise) {
      try {
        await task.executionPromise;
      } catch {
        // interrupted execution rejection must not block cleanup.
      }
    }
  }

  async markRunningTaskInterruptedForShutdown(
    task: Task,
    shutdownAt: Date,
  ): Promise<void> {
    if (task.status !== "running") return;

    task.status = "interrupted";
    task.completedAt = shutdownAt;
    recordTerminationHint(task, "killed", "shutdown");
    await this.persistFinalState(task, SHUTDOWN_INTERRUPT_LOGS);
  }

  async interruptForShutdown(task: Task): Promise<void> {
    if (!task.engine) return;

    try {
      await task.engine.interrupt();
    } catch {
      // idempotent; shutdown drain collection must continue.
    }
  }

  getDrainPromise(task: Task): Promise<void> | undefined {
    return task.executionPromise?.catch(() => undefined);
  }

  async finalizeExternalTask(
    task: Task,
    params: ExternalFinalizeParams,
  ): Promise<Task> {
    if (params.result !== undefined) {
      task.status = "completed";
      task.result = params.result;
      task.error = undefined;
    } else {
      task.status = "error";
      task.error = params.error;
      task.result = undefined;
    }
    task.completedAt = new Date();
    if (params.llmUsage !== undefined) {
      task.llmUsage = params.llmUsage;
    }

    await this.persistFinalState(task, EXTERNAL_FINALIZE_LOGS);
    return task;
  }

  async persistExecutorFinalState(task: Task): Promise<void> {
    await this.persistFinalState(task, EXECUTOR_FINALIZE_LOGS);
  }

  private async persistFinalState(
    task: Task,
    messages: FinalStateLogMessages,
  ): Promise<void> {
    const termination = finalizeTaskTermination(task);
    if (termination.newlyFinalized && !task.terminationEventRecorded) {
      await this.persistAndBroadcastSessionEnded(task, messages);
    }

    try {
      await this.deps.db.updateSession(task.agentSessionId, {
        status: task.status,
        last_event_id: task.lastEventId,
        termination_reason: termination.reason,
        termination_detail: termination.detail,
      });
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        messages.db,
      );
    }

    try {
      await this.deps.broadcaster.emitSessionUpdated(task);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        messages.broadcast,
      );
    }
  }

  private async persistAndBroadcastSessionEnded(
    task: Task,
    messages: FinalStateLogMessages,
  ): Promise<void> {
    const event = buildSessionEndedEvent(task);
    try {
      const eventId = await this.deps.db.appendEvent({
        sessionId: task.agentSessionId,
        eventType: "session_ended",
        payload: JSON.stringify(event),
        searchableText: "",
        createdAt: task.completedAt ?? new Date(),
      });
      task.lastEventId = eventId;
      (event as Record<string, unknown>)._event_id = eventId;
      task.terminationEventRecorded = true;
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        messages.db,
      );
    }

    try {
      await this.deps.broadcaster.emitEventEnvelope(task.agentSessionId, event);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        messages.broadcast,
      );
    }
  }
}
