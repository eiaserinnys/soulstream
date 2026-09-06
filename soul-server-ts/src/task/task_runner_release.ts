import type { TaskRunnerRuntime } from "../runner/task_runner_runtime.js";

import type { RunnerReleaseClaim, Task } from "./task_models.js";

/** Releases only the runner attachment that the caller actually observed. */
export function releaseTaskRunner(
  task: Task,
  runner: TaskRunnerRuntime,
): boolean {
  if (task.runner !== runner) return false;
  if (task.runnerReleaseClaim?.runner === runner) return false;
  clearTaskRunner(task);
  return true;
}

/** Completes an exact claimed release only after its registration is retired. */
export function completeTaskRunnerReleaseClaim(
  task: Task,
  claim: RunnerReleaseClaim,
): boolean {
  if (
    task.runner !== claim.runner
    || task.runnerReleaseClaim !== claim
    || claim.runner.dispatcher.registrationId() !== claim.registrationId
  ) return false;
  task.runnerReleaseClaim = undefined;
  clearTaskRunner(task);
  claim.resolve();
  return true;
}

function clearTaskRunner(task: Task): void {
  task.runner = undefined;
  task.runnerRetainedForDetachedWork = undefined;
  task.runnerIsOfflineReplay = undefined;
}
