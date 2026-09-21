import type { Task } from "../task/task_models.js";

export function listActiveTaskWorkspaceDirs(
  tasks: readonly Task[],
  profileWorkspace: (profileId: string) => string | undefined,
): string[] {
  return tasks
    .filter((task) => task.status === "initializing"
      || task.status === "running"
      || task.runner !== undefined)
    .map((task) => task.resolvedWorkspaceDir
      ?? task.runner?.engine.workspaceDir
      ?? (task.profileId ? profileWorkspace(task.profileId) : undefined))
    .filter((path): path is string => Boolean(path));
}
