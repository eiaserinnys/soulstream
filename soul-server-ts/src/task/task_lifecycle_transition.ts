import type { Logger } from "pino";

import type { EventPersistence } from "../db/event_persistence.js";

import type { Task } from "./task_models.js";
import { reviewStateAfterTerminal } from "./session_review.js";
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
  logger: Logger;
  persistence?: EventPersistence;
}

export class TaskLifecycleTransition {
  constructor(private readonly deps: TaskLifecycleTransitionDeps) {}

  async cancelRunningTask(task: Task | undefined): Promise<boolean> {
    if (!task) return false;
    if (task.status !== "running") return false;
    if (!task.runner) return false;

    task.status = "interrupted";
    recordTerminationHint(task, "killed", "cancelled");
    return await task.runner.dispatcher.interrupt();
  }

  async interruptAndDrain(task: Task): Promise<void> {
    if (!task.runner) return;

    try {
      await task.runner.dispatcher.interrupt();
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
    await this.persistFinalState(task);
  }

  async interruptForShutdown(task: Task): Promise<void> {
    if (!task.runner) return;

    try {
      await task.runner.dispatcher.interrupt();
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

    await this.persistFinalState(task);
    return task;
  }

  async persistExecutorFinalState(task: Task): Promise<void> {
    await this.persistFinalState(task);
  }

  private async persistFinalState(task: Task): Promise<void> {
    const termination = finalizeTaskTermination(task);
    if (termination.newlyFinalized) {
      task.reviewState = reviewStateAfterTerminal(task.reviewRequired === true);
    }
    if (termination.newlyFinalized && !task.terminationEventRecorded) {
      await this.enqueueAndAwaitSessionEnded(task, termination.reason, termination.detail);
    }
  }

  private async enqueueAndAwaitSessionEnded(
    task: Task,
    terminationReason: string,
    terminationDetail: string | null,
  ): Promise<void> {
    if (!this.deps.persistence) {
      throw new Error("session_ended durable event persistence is required");
    }
    const event = buildSessionEndedEvent(task);
    const { eventId } = await this.deps.persistence.enqueueEventAndWaitForSessionAck(
      task.agentSessionId,
      event,
      {
        kind: "terminal_transition",
        status: task.status,
        termination_reason: terminationReason,
        termination_detail: terminationDetail,
        review_state: task.reviewState ?? "not_required",
        last_assistant_text: task.lastAssistantText ?? null,
        updated_at: (task.completedAt ?? new Date()).toISOString(),
      },
    );
    task.lastEventId = eventId;
    task.terminationEventRecorded = true;
  }

}
