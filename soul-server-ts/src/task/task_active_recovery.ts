import type { Logger } from "pino";

import type { Task } from "./task_models.js";

type ActiveTaskRecoveryLogger = Pick<Logger, "warn">;

export type InterventionTaskActivity =
  | "active-running"
  | "detached-hydrated-running"
  | "terminal";

export type InterventionTaskRoute = "running" | "auto-resume";

/**
 * Classifies whether addIntervention can treat a task as actively running.
 *
 * DB hydration can restore a session row whose status is still "running", but
 * the in-memory engine and execution promise are gone after process restart.
 * That task must be treated as terminal so the existing auto-resume transition
 * can create a user_message and start the next turn.
 */
export function classifyInterventionTaskActivity(task: Task): InterventionTaskActivity {
  if (task.status !== "running") {
    return "terminal";
  }

  if (task.hydratedFromDb === true && !task.engine && !task.executionPromise) {
    return "detached-hydrated-running";
  }

  return "active-running";
}

export class ActiveTaskRecovery {
  constructor(private readonly logger: ActiveTaskRecoveryLogger) {}

  prepareForIntervention(task: Task): InterventionTaskRoute {
    const activity = classifyInterventionTaskActivity(task);
    if (activity === "active-running") {
      return "running";
    }

    if (activity === "detached-hydrated-running") {
      this.markDetachedRunningTaskInterrupted(task);
    }

    return "auto-resume";
  }

  private markDetachedRunningTaskInterrupted(task: Task): void {
    this.logger.warn(
      { sessionId: task.agentSessionId },
      "hydrated running task has no active execution; auto-resuming instead of queueing",
    );
    task.status = "interrupted";
    task.completedAt = new Date();
  }
}
