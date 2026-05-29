import { describe, expect, it, vi } from "vitest";

import {
  ClaudeRuntimeCommandError,
  ClaudeRuntimeCommands,
} from "../../src/upstream/claude_runtime_commands.js";

describe("ClaudeRuntimeCommands", () => {
  it("returns ACK payloads for background task list/output/stop commands", async () => {
    const taskManager = {
      listClaudeRuntimeTasks: vi.fn(async () => ({
        sessionId: "sess-1",
        sessionState: "running",
        runtimeSessionId: "claude-sess-1",
        updatedAt: 10,
        tasks: [{ taskId: "bg-1", status: "running", updatedAt: 10 }],
      })),
      getClaudeRuntimeTaskOutput: vi.fn(async () => ({
        sessionId: "sess-1",
        taskId: "bg-1",
        task: { taskId: "bg-1", status: "completed", updatedAt: 12 },
        output: "done",
        outputAvailable: true,
        truncated: false,
      })),
      stopClaudeRuntimeTask: vi.fn(async () => ({
        sessionId: "sess-1",
        taskId: "bg-1",
        supported: true,
        stopped: true,
        alreadyTerminal: false,
        status: "ok",
        task: { taskId: "bg-1", status: "running", updatedAt: 10 },
      })),
      backgroundClaudeRuntimeTasks: vi.fn(async () => ({
        sessionId: "sess-1",
        supported: true,
        backgrounded: true,
        status: "ok",
      })),
    };
    const commands = new ClaudeRuntimeCommands(taskManager);

    await expect(
      commands.listTasks({
        type: "claude_runtime_list_tasks",
        requestId: "req-list",
        agentSessionId: "sess-1",
      }),
    ).resolves.toMatchObject({
      type: "claude_runtime_list_tasks_ack",
      requestId: "req-list",
      status: "ok",
      tasks: [{ taskId: "bg-1" }],
    });
    await expect(
      commands.taskOutput({
        type: "claude_runtime_task_output",
        requestId: "req-output",
        agentSessionId: "sess-1",
        taskId: "bg-1",
      }),
    ).resolves.toMatchObject({
      type: "claude_runtime_task_output_ack",
      requestId: "req-output",
      output: "done",
      outputAvailable: true,
    });
    await expect(
      commands.stopTask({
        type: "claude_runtime_stop_task",
        requestId: "req-stop",
        agentSessionId: "sess-1",
        taskId: "bg-1",
      }),
    ).resolves.toMatchObject({
      type: "claude_runtime_stop_task_ack",
      requestId: "req-stop",
      stopped: true,
    });
    await expect(
      commands.backgroundTasks({
        type: "claude_runtime_background_tasks",
        requestId: "req-background",
        agentSessionId: "sess-1",
        toolUseId: "toolu-bash",
      }),
    ).resolves.toMatchObject({
      type: "claude_runtime_background_tasks_ack",
      requestId: "req-background",
      backgrounded: true,
    });

    expect(taskManager.listClaudeRuntimeTasks).toHaveBeenCalledWith("sess-1");
    expect(taskManager.getClaudeRuntimeTaskOutput).toHaveBeenCalledWith("sess-1", "bg-1");
    expect(taskManager.stopClaudeRuntimeTask).toHaveBeenCalledWith("sess-1", "bg-1");
    expect(taskManager.backgroundClaudeRuntimeTasks).toHaveBeenCalledWith(
      "sess-1",
      "toolu-bash",
    );
  });

  it("backgroundTasks command preserves no_match as a non-backgrounded ACK", async () => {
    const taskManager = {
      listClaudeRuntimeTasks: vi.fn(),
      getClaudeRuntimeTaskOutput: vi.fn(),
      stopClaudeRuntimeTask: vi.fn(),
      backgroundClaudeRuntimeTasks: vi.fn(async () => ({
        sessionId: "sess-1",
        supported: true,
        backgrounded: false,
        status: "no_match",
        message: "No foreground Claude task matched toolUseId: toolu-missing",
      })),
    };
    const commands = new ClaudeRuntimeCommands(taskManager);

    await expect(
      commands.backgroundTasks({
        type: "claude_runtime_background_tasks",
        requestId: "req-background",
        agentSessionId: "sess-1",
        toolUseId: "toolu-missing",
      }),
    ).resolves.toMatchObject({
      type: "claude_runtime_background_tasks_ack",
      requestId: "req-background",
      status: "no_match",
      backgrounded: false,
      message: expect.stringContaining("toolu-missing"),
    });
  });

  it("routes schedule list/delete commands to the durable schedule service", async () => {
    const schedules = {
      listSchedules: vi.fn(async () => ({
        sessionId: "sess-1",
        nextRunAt: "2026-01-01T00:10:00.000Z",
        schedules: [{ scheduleId: "sched-1", status: "active" }],
      })),
      deleteSchedule: vi.fn(async () => ({
        sessionId: "sess-1",
        scheduleId: "sched-1",
        status: "cancelled",
        deleted: true,
        schedule: { scheduleId: "sched-1", status: "cancelled" },
      })),
    };
    const commands = new ClaudeRuntimeCommands(
      {
        listClaudeRuntimeTasks: vi.fn(),
        getClaudeRuntimeTaskOutput: vi.fn(),
        stopClaudeRuntimeTask: vi.fn(),
        backgroundClaudeRuntimeTasks: vi.fn(),
      },
      schedules as never,
    );

    await expect(
      commands.listSchedules({
        type: "claude_runtime_list_schedules",
        requestId: "req-schedules",
        agentSessionId: "sess-1",
      }),
    ).resolves.toMatchObject({
      type: "claude_runtime_list_schedules_ack",
      requestId: "req-schedules",
      schedules: [{ scheduleId: "sched-1" }],
      nextRunAt: "2026-01-01T00:10:00.000Z",
    });
    await expect(
      commands.deleteSchedule({
        type: "claude_runtime_delete_schedule",
        requestId: "req-delete",
        agentSessionId: "sess-1",
        scheduleId: "sched-1",
      }),
    ).resolves.toMatchObject({
      type: "claude_runtime_delete_schedule_ack",
      requestId: "req-delete",
      deleted: true,
      scheduleId: "sched-1",
    });

    expect(schedules.listSchedules).toHaveBeenCalledWith("sess-1");
    expect(schedules.deleteSchedule).toHaveBeenCalledWith("sess-1", "sched-1");
  });

  it("returns null for fire-and-forget commands and validates required ids", async () => {
    const commands = new ClaudeRuntimeCommands({
      listClaudeRuntimeTasks: vi.fn(async () => ({
        sessionId: "sess-1",
        sessionState: null,
        runtimeSessionId: null,
        updatedAt: null,
        tasks: [],
      })),
      getClaudeRuntimeTaskOutput: vi.fn(),
      stopClaudeRuntimeTask: vi.fn(),
      backgroundClaudeRuntimeTasks: vi.fn(),
    });

    await expect(
      commands.listTasks({
        type: "claude_runtime_list_tasks",
        agentSessionId: "sess-1",
      }),
    ).resolves.toBeNull();
    await expect(
      commands.stopTask({
        type: "claude_runtime_stop_task",
        requestId: "req-stop",
        agentSessionId: "sess-1",
      }),
    ).rejects.toBeInstanceOf(ClaudeRuntimeCommandError);
  });
});
