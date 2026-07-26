import type { SessionDB } from "../../src/db/session_db.js";
import type { SupportsClaudeBackgroundTasks } from "../../src/engine/protocol.js";
import type { ClaudeSessionRuntimeControl } from "../../src/engine/claude_session_client_registry.js";
import { TaskClaudeRuntimeControlRoute } from "../../src/task/task_claude_runtime_control_route.js";
import type { ClaudeRuntimeState, Task } from "../../src/task/task_models.js";
import { describe, expect, it, vi } from "vitest";

function makeTask(): Task {
  return {
    agentSessionId: "session-1",
    prompt: "background work",
    status: "completed",
    createdAt: new Date("2026-07-26T00:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
    claudeRuntime: {
      tasks: {
        "bg-1": {
          taskId: "bg-1",
          status: "running",
          updatedAt: 1,
        },
      },
    } as ClaudeRuntimeState,
  };
}

function makeRegistryControl(): ClaudeSessionRuntimeControl {
  return {
    has: vi.fn().mockReturnValue(true),
    close: vi.fn().mockResolvedValue(true),
    deliverInputResponse: vi.fn().mockResolvedValue({ status: "delivered" }),
    backgroundClaudeRuntimeTasks: vi.fn().mockResolvedValue({ status: "ok" }),
    stopClaudeRuntimeTask: vi.fn().mockResolvedValue({ status: "ok" }),
  };
}

describe("TaskClaudeRuntimeControlRoute", () => {
  it("uses session registry controls after the foreground engine has been released", async () => {
    const task = makeTask();
    const registry = makeRegistryControl();
    const route = new TaskClaudeRuntimeControlRoute({
      db: {} as SessionDB,
      getTask: () => task,
      sessionRuntimeControl: registry,
    });

    await expect(route.stopClaudeRuntimeTask("session-1", "bg-1")).resolves.toMatchObject({
      supported: true,
      stopped: true,
      status: "ok",
    });
    await expect(route.backgroundClaudeRuntimeTasks(
      "session-1",
      "tool-1",
    )).resolves.toMatchObject({
      supported: true,
      backgrounded: true,
      status: "ok",
    });

    expect(registry.stopClaudeRuntimeTask).toHaveBeenCalledWith("session-1", "bg-1");
    expect(registry.backgroundClaudeRuntimeTasks)
      .toHaveBeenCalledWith("session-1", "tool-1");
  });

  it("keeps the legacy turn-scoped engine path when no registry control is injected", async () => {
    const task = makeTask();
    const stopClaudeRuntimeTask = vi.fn().mockResolvedValue({ status: "ok" });
    const backgroundClaudeRuntimeTasks = vi.fn().mockResolvedValue({ status: "ok" });
    task.status = "running";
    task.engine = {
      stopClaudeRuntimeTask,
      backgroundClaudeRuntimeTasks,
    } as unknown as SupportsClaudeBackgroundTasks & Task["engine"];
    const route = new TaskClaudeRuntimeControlRoute({
      db: {} as SessionDB,
      getTask: () => task,
    });

    await route.stopClaudeRuntimeTask("session-1", "bg-1");
    await route.backgroundClaudeRuntimeTasks("session-1", "tool-1");

    expect(stopClaudeRuntimeTask).toHaveBeenCalledWith("bg-1");
    expect(backgroundClaudeRuntimeTasks).toHaveBeenCalledWith("tool-1");
  });

  it("routes bind-window controls to the reserved registry instead of the turn engine", async () => {
    const task = makeTask();
    const engineStop = vi.fn().mockResolvedValue({ status: "ok" });
    const engineBackground = vi.fn().mockResolvedValue({ status: "ok" });
    task.status = "running";
    task.engine = {
      stopClaudeRuntimeTask: engineStop,
      backgroundClaudeRuntimeTasks: engineBackground,
    } as unknown as SupportsClaudeBackgroundTasks & Task["engine"];
    const registry = makeRegistryControl();
    const route = new TaskClaudeRuntimeControlRoute({
      db: {} as SessionDB,
      getTask: () => task,
      sessionRuntimeControl: registry,
    });

    await route.stopClaudeRuntimeTask("session-1", "bg-1");
    await route.backgroundClaudeRuntimeTasks("session-1", "tool-1");

    expect(registry.stopClaudeRuntimeTask).toHaveBeenCalledWith("session-1", "bg-1");
    expect(registry.backgroundClaudeRuntimeTasks)
      .toHaveBeenCalledWith("session-1", "tool-1");
    expect(engineStop).not.toHaveBeenCalled();
    expect(engineBackground).not.toHaveBeenCalled();
  });
});
