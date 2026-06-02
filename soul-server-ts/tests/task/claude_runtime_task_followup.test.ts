import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { SSEEventPayload } from "../../src/engine/protocol.js";
import {
  CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
  ClaudeRuntimeTaskFollowupController,
} from "../../src/task/claude_runtime_task_followup.js";
import type { Task } from "../../src/task/task_models.js";

const silentLogger = pino({ level: "silent" });

function makeTask(): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "running",
    profileId: "claude-roselin",
    createdAt: new Date(),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
    claudeRuntime: {
      sessionState: "idle",
      updatedAt: Date.now(),
      tasks: {},
    },
  };
}

function makeController() {
  const addIntervention = vi.fn(async () => ({ queued: true, queuePosition: 1 }));
  const onResume = vi.fn();
  const controller = new ClaudeRuntimeTaskFollowupController({
    taskManager: { addIntervention },
    onResume,
    logger: silentLogger,
  });
  return { controller, addIntervention, onResume };
}

describe("ClaudeRuntimeTaskFollowupController", () => {
  it("background task notification을 TaskManager intervention으로 flush한다", async () => {
    const task = makeTask();
    task.claudeRuntime!.tasks["task-1"] = {
      taskId: "task-1",
      status: "completed",
      updatedAt: Date.now(),
      isBackgrounded: true,
      outputFile: "/tmp/task-1.output",
      summary: "uploaded wav files",
    };
    const { controller, addIntervention, onResume } = makeController();

    controller.collect(task, {
      type: "claude_runtime_task_notification",
      task_id: "task-1",
      status: "completed",
      summary: "uploaded wav files",
      output_file: "/tmp/task-1.output",
    } as SSEEventPayload);
    await controller.flush(task);

    expect(addIntervention).toHaveBeenCalledTimes(1);
    expect(addIntervention).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: "sess-1",
        user: "system",
        source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
        followupAttempt: 1,
        followupKey: "sess-1:task-1",
        text: expect.stringContaining("task-1"),
      }),
      onResume,
    );
    const text = addIntervention.mock.calls[0]![0].text;
    expect(text).toContain("/tmp/task-1.output");
    expect(text).toContain("uploaded wav files");
    expect(text).toContain("직전 응답을 그대로 반복하지 마세요");
  });

  it("notification이 누락되어도 terminal task_updated background patch를 follow-up 후보로 삼는다", async () => {
    const task = makeTask();
    task.claudeRuntime!.tasks["task-2"] = {
      taskId: "task-2",
      status: "completed",
      updatedAt: Date.now(),
      isBackgrounded: true,
      outputFile: "/tmp/task-2.output",
    };
    const { controller, addIntervention } = makeController();

    controller.collect(task, {
      type: "claude_runtime_task_updated",
      task_id: "task-2",
      patch: {
        status: "completed",
        is_backgrounded: true,
        output_file: "/tmp/task-2.output",
      },
    } as unknown as SSEEventPayload);
    await controller.flush(task);

    const params = addIntervention.mock.calls[0]![0];
    expect(params.followupKey).toBe("sess-1:task-2");
    expect(params.text).toContain("task-2");
    expect(params.text).toContain("/tmp/task-2.output");
  });

  it("동일 task의 task_updated와 notification은 dedup하고 notification 세부 정보를 보존한다", async () => {
    const task = makeTask();
    task.claudeRuntime!.tasks["task-3"] = {
      taskId: "task-3",
      status: "completed",
      updatedAt: Date.now(),
      isBackgrounded: true,
      outputFile: "/tmp/result.output",
      summary: "final summary",
    };
    const { controller, addIntervention } = makeController();

    controller.collect(task, {
      type: "claude_runtime_task_updated",
      task_id: "task-3",
      patch: { status: "completed", is_backgrounded: true },
    } as unknown as SSEEventPayload);
    controller.collect(task, {
      type: "claude_runtime_task_notification",
      task_id: "task-3",
      status: "completed",
      summary: "final summary",
      output_file: "/tmp/result.output",
    } as SSEEventPayload);
    await controller.flush(task);

    const text = addIntervention.mock.calls[0]![0].text;
    expect((text.match(/task-3/g) ?? [])).toHaveLength(1);
    expect(text).toContain("final summary");
    expect(text).toContain("/tmp/result.output");
  });

  it("이미 flush된 task notification이 늦게 다시 도착하면 재발화하지 않는다", async () => {
    const task = makeTask();
    task.claudeRuntime!.tasks["task-4"] = {
      taskId: "task-4",
      status: "completed",
      updatedAt: Date.now(),
      isBackgrounded: true,
    };
    const { controller, addIntervention } = makeController();
    const event = {
      type: "claude_runtime_task_notification",
      task_id: "task-4",
      status: "completed",
    } as SSEEventPayload;

    controller.collect(task, event);
    await controller.flush(task);
    controller.collect(task, event);
    await controller.flush(task);

    expect(addIntervention).toHaveBeenCalledTimes(1);
  });

  it("같은 turn의 여러 완료 task를 하나의 ordered batch prompt로 합친다", async () => {
    const task = makeTask();
    task.claudeRuntime!.tasks["task-a"] = {
      taskId: "task-a",
      status: "completed",
      updatedAt: Date.now(),
      isBackgrounded: true,
    };
    task.claudeRuntime!.tasks["task-b"] = {
      taskId: "task-b",
      status: "completed",
      updatedAt: Date.now(),
      isBackgrounded: true,
    };
    const { controller, addIntervention } = makeController();

    controller.collect(task, {
      type: "claude_runtime_task_notification",
      task_id: "task-a",
      status: "completed",
      summary: "first done",
    } as SSEEventPayload);
    controller.collect(task, {
      type: "claude_runtime_task_notification",
      task_id: "task-b",
      status: "completed",
      summary: "second done",
    } as SSEEventPayload);
    await controller.flush(task);

    expect(addIntervention).toHaveBeenCalledTimes(1);
    const text = addIntervention.mock.calls[0]![0].text;
    expect(text.indexOf("task-a")).toBeLessThan(text.indexOf("task-b"));
    expect(text).toContain("first done");
    expect(text).toContain("second done");
    expect(addIntervention.mock.calls[0]![0].followupKey).toBe("sess-1:task-a,task-b");
  });
});
