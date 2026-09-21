import { describe, expect, it } from "vitest";

import { listActiveTaskWorkspaceDirs } from
  "../../src/runtime/task_active_workspace_dirs.js";
import type { Task } from "../../src/task/task_models.js";

function task(input: Partial<Task>): Task {
  return input as Task;
}

describe("active task workspace protection", () => {
  it("uses a recovered retained runner cwd before the stale profile fallback", () => {
    const actual = listActiveTaskWorkspaceDirs([
      task({
        status: "completed",
        profileId: "agent-a",
        runner: { engine: { workspaceDir: "/projects/recovered-worktree" } } as Task["runner"],
      }),
    ], () => "/projects/base-profile");

    expect(actual).toEqual(["/projects/recovered-worktree"]);
  });

  it("keeps the resolved workspace authoritative for live tasks", () => {
    const actual = listActiveTaskWorkspaceDirs([
      task({
        status: "running",
        profileId: "agent-a",
        resolvedWorkspaceDir: "/projects/resolved-worktree",
        runner: { engine: { workspaceDir: "/projects/runner-worktree" } } as Task["runner"],
      }),
      task({ status: "completed", profileId: "agent-a" }),
    ], () => "/projects/base-profile");

    expect(actual).toEqual(["/projects/resolved-worktree"]);
  });
});
