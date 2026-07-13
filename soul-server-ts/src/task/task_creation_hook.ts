import type { CreateTaskParams } from "./task_creation.js";
import type { SessionCreationWarning, Task } from "./task_models.js";

export interface TaskCreationHookParams {
  task: Task;
  params: CreateTaskParams;
}

export interface LegacyProjectionHookParams extends TaskCreationHookParams {
  assignedFolderId: string | null;
  completed: boolean;
}

/** Post-registration seam for durable session projections. */
export interface TaskCreationHook {
  afterSessionRegistered(params: TaskCreationHookParams): Promise<void>;
  afterLegacyProjection?(params: LegacyProjectionHookParams): Promise<void>;
}

export const NOOP_TASK_CREATION_HOOK: TaskCreationHook = {
  async afterSessionRegistered(): Promise<void> {},
};

export function appendCreationWarning(task: Task, warning: SessionCreationWarning): void {
  if (task.creationWarnings?.some((current) => current.code === warning.code)) return;
  task.creationWarnings = [...(task.creationWarnings ?? []), warning];
}
