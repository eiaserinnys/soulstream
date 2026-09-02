import type { Task } from "./task_models.js";

export function hasLiveExecutionEvidence(task: Task): boolean {
  return task.executionRegistration !== undefined
    || task.runner?.dispatcher.hasActiveExecution() === true;
}
