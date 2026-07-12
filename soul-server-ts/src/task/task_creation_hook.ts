import type { CreateTaskParams } from "./task_creation.js";
import type { Task } from "./task_models.js";

export interface TaskCreationHookParams {
  task: Task;
  params: CreateTaskParams;
}

/** Post-registration seam for durable session projections. */
export interface TaskCreationHook {
  afterSessionRegistered(params: TaskCreationHookParams): Promise<void>;
}

export const NOOP_TASK_CREATION_HOOK: TaskCreationHook = {
  async afterSessionRegistered(): Promise<void> {},
};
