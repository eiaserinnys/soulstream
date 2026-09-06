import type { TaskRunnerRuntime } from "../runner/task_runner_runtime.js";

import type { Task } from "./task_models.js";

/** Releases only the runner attachment that the caller actually observed. */
export function releaseTaskRunner(
  task: Task,
  runner: TaskRunnerRuntime,
): boolean {
  if (task.runner !== runner) return false;
  const claim = task.runnerReleaseClaim;
  task.runner = undefined;
  task.runnerRetainedForDetachedWork = undefined;
  task.runnerIsOfflineReplay = undefined;
  if (claim?.runner === runner) {
    task.runnerReleaseClaim = undefined;
    claim.resolve();
  }
  return true;
}
