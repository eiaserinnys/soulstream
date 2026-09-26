import { isTerminalTaskStatus, type Task } from "./task_models.js";
import type { TaskLifecycleTransition } from "./task_lifecycle_transition.js";
import { releaseTaskRunner } from "./task_runner_release.js";

export interface TaskRunnerRecoveryDeps {
  getTask(sessionId: string): Task | undefined;
  loadTask(sessionId: string): Promise<Task | null>;
  rememberTask(task: Task): void;
  lifecycleTransition: TaskLifecycleTransition;
}

/**
 * Rehydrates runner-backed tasks and converts an unrecoverable runner into the
 * ordinary terminal-error transition. A later explicit input or resume may
 * start another execution.
 */
export class TaskRunnerRecovery {
  constructor(private readonly deps: TaskRunnerRecoveryDeps) {}

  async hydrate(sessionId: string): Promise<Task | null> {
    const active = this.deps.getTask(sessionId);
    if (active) return active;
    const task = await this.deps.loadTask(sessionId);
    if (task) this.deps.rememberTask(task);
    return task;
  }

  async markFailure(
    task: Task,
    message: string,
  ): Promise<void> {
    if (isTerminalTaskStatus(task.status)) return;
    const runner = task.runner;
    if (runner) releaseTaskRunner(task, runner);
    task.executionPromise = undefined;
    task.error = message;
    this.deps.lifecycleTransition.applyRunnerTerminalFact(task, "reaped", message);
    const persistence = await this.deps.lifecycleTransition.persistExecutorFinalState(task, true);
    await this.deps.lifecycleTransition.notifyCompletionIfApplied(task, persistence);
  }

  async projectClosed(task: Task, detail: string): Promise<boolean> {
    if (task.terminationEventRecorded) return false;
    const runner = task.runner;
    if (runner) releaseTaskRunner(task, runner);
    task.executionPromise = undefined;
    this.deps.lifecycleTransition.applyRunnerTerminalFact(task, "closed", detail);
    const persistence = await this.deps.lifecycleTransition.persistExecutorFinalState(task, true);
    await this.deps.lifecycleTransition.notifyCompletionIfApplied(task, persistence);
    return persistence.terminalTransitionApplied;
  }

}
