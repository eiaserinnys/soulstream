import type { TaskRunnerRuntime } from "../runner/task_runner_runtime.js";

import type { Task } from "./task_models.js";

/** Releases only the runner attachment that the caller actually observed. */
export function releaseTaskRunner(
  task: Task,
  runner: TaskRunnerRuntime,
): boolean {
  if (task.runner !== runner) return false;
  task.runner = undefined;
  task.runnerRetainedForClaudeBackground = undefined;
  task.runnerIsOfflineReplay = undefined;
  return true;
}
