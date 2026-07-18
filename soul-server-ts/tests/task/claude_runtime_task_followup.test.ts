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
  const sleep = vi.fn(async () => undefined);
  const controller = new ClaudeRuntimeTaskFollowupController({
    taskManager: { addIntervention },
    onResume,
    logger: silentLogger,
    sleep,
  });
  return { controller, addIntervention, onResume, sleep };
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

  it("local_agent terminal notification은 is_backgrounded 표식 없이도 follow-up한다", async () => {
    const task = makeTask();
    task.claudeRuntime!.tasks["agent-task"] = {
      taskId: "agent-task",
      status: "stopped",
      updatedAt: Date.now(),
      taskType: "local_agent",
      description: "PR diff review",
    };
    const { controller, addIntervention } = makeController();

    controller.collect(task, {
      type: "claude_runtime_task_notification",
      task_id: "agent-task",
      status: "stopped",
      summary: "PR diff review",
      output_file: "",
    } as SSEEventPayload);
    await controller.flush(task);

    expect(addIntervention).toHaveBeenCalledTimes(1);
    expect(addIntervention.mock.calls[0]![0]).toMatchObject({
      followupKey: "sess-1:agent-task",
      followupTaskIds: ["agent-task"],
    });
    expect(addIntervention.mock.calls[0]![0].text).toContain("status=stopped");
  });

  it("failed/stopped/killed follow-up prompt는 완료로 오인하지 않도록 상태를 진실하게 설명한다", async () => {
    const task = makeTask();
    for (const runtimeTask of [
      {
        taskId: "task-failed",
        status: "failed" as const,
        error: "upload failed",
      },
      {
        taskId: "task-stopped",
        status: "stopped" as const,
      },
      {
        taskId: "task-killed",
        status: "killed" as const,
      },
    ]) {
      task.claudeRuntime!.tasks[runtimeTask.taskId] = {
        taskId: runtimeTask.taskId,
        status: runtimeTask.status,
        updatedAt: Date.now(),
        isBackgrounded: true,
        description: "Long running verification",
        toolUseId: `toolu_${runtimeTask.status}`,
        error: runtimeTask.error,
      };
    }
    const { controller, addIntervention } = makeController();

    for (const taskId of ["task-failed", "task-stopped", "task-killed"]) {
      controller.collect(task, {
        type: "claude_runtime_task_updated",
        task_id: taskId,
        patch: { status: task.claudeRuntime!.tasks[taskId]!.status },
      } as unknown as SSEEventPayload);
    }
    await controller.flush(task);

    const text = addIntervention.mock.calls[0]![0].text;
    expect(text).not.toContain("백그라운드 Claude runtime task가 완료되었습니다.");
    expect(text).toContain("status=failed 항목은 실패했습니다");
    expect(text).toContain("status=stopped 항목은 완료 전에 중단");
    expect(text).toContain("완료 전에 강제 종료");
    expect(text).toContain("결과가 없을 수 있습니다");
    expect(text).toContain("task_id=task-failed");
    expect(text).toContain("status=failed");
    expect(text).toContain("error=upload failed");
    expect(text).toContain("task_id=task-stopped");
    expect(text).toContain("status=stopped");
    expect(text).toContain("task_id=task-killed");
    expect(text).toContain("status=killed");
  });

  it("flush 실패 시 pending follow-up을 보존해 다음 flush에서 재시도한다", async () => {
    const task = makeTask();
    task.claudeRuntime!.tasks["task-retry"] = {
      taskId: "task-retry",
      status: "completed",
      updatedAt: Date.now(),
      isBackgrounded: true,
      summary: "retry me",
    };
    const addIntervention = vi
      .fn()
      .mockRejectedValueOnce(new Error("route unavailable"))
      .mockResolvedValueOnce({ queued: true, queuePosition: 1 });
    const controller = new ClaudeRuntimeTaskFollowupController({
      taskManager: { addIntervention },
      onResume: vi.fn(),
      logger: silentLogger,
    });

    controller.collect(task, {
      type: "claude_runtime_task_notification",
      task_id: "task-retry",
      status: "completed",
      summary: "retry me",
    } as SSEEventPayload);

    await expect(controller.flush(task)).rejects.toThrow("route unavailable");
    await controller.flush(task);

    expect(addIntervention).toHaveBeenCalledTimes(2);
    expect(addIntervention.mock.calls[1]![0].text).toContain("task-retry");
    expect(addIntervention.mock.calls[1]![0].text).toContain("retry me");
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

  it("fallback은 execution drain 뒤 5초를 기다려 terminal auto-resume route로 보낸다", async () => {
    const task = makeTask();
    task.executionPromise = Promise.resolve();
    const { controller, addIntervention, onResume, sleep } = makeController();

    await controller.queueFallback(
      task,
      {
        text: "original background task status prompt",
        user: "system",
        source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
        followupAttempt: 1,
        followupKey: "sess-1:task-1",
      },
      "empty_response",
    );

    expect(addIntervention).toHaveBeenCalledWith(
      expect.objectContaining({
        followupAttempt: 2,
        followupKey: "sess-1:task-1",
        onlyIfTerminal: true,
        text: expect.stringContaining("빈 응답으로 끝났습니다"),
      }),
      onResume,
    );
    expect(sleep).toHaveBeenCalledWith(5_000);
    const text = addIntervention.mock.calls[0]![0].text;
    expect(text).toContain("원래 follow-up 지시");
    expect(text).toContain("background task status");
    expect(text).not.toContain("완료된 백그라운드 작업 결과");
  });

  it("빈 attach 뒤 fallback은 재수화된 최신 status와 output_file로 지시를 갱신한다", async () => {
    const task = makeTask();
    task.executionPromise = Promise.resolve();
    task.claudeRuntime!.tasks["agent-task"] = {
      taskId: "agent-task",
      status: "stopped",
      updatedAt: Date.now(),
      taskType: "local_agent",
      isBackgrounded: true,
      outputFile: "/tmp/agent-task.output",
      summary: "No completion record was found; transcript is saved on disk.",
      description: "PR diff review",
    };
    const { controller, addIntervention } = makeController();

    await controller.queueFallback(
      task,
      {
        text: "stale prompt without an output path",
        user: "system",
        source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
        followupAttempt: 1,
        followupKey: "sess-1:agent-task",
        followupTaskIds: ["agent-task"],
      },
      "empty_response",
    );

    const params = addIntervention.mock.calls[0]![0];
    expect(params.followupTaskIds).toEqual(["agent-task"]);
    expect(params.text).toContain("status=stopped");
    expect(params.text).toContain("/tmp/agent-task.output");
    expect(params.text).toContain("No completion record was found");
    expect(params.text).not.toContain("stale prompt without an output path");
  });

  it("attempt 2 fallback은 30초 백오프 뒤 마지막 fresh turn을 예약한다", async () => {
    const task = makeTask();
    task.executionPromise = Promise.resolve();
    const { controller, addIntervention, sleep } = makeController();

    await controller.queueFallback(
      task,
      {
        text: "retry attempt 2",
        user: "system",
        source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
        followupAttempt: 2,
        followupKey: "sess-1:task-1",
      },
      "repeated_response",
    );

    expect(sleep).toHaveBeenCalledWith(30_000);
    expect(addIntervention).toHaveBeenCalledWith(
      expect.objectContaining({ followupAttempt: 3, onlyIfTerminal: true }),
      expect.any(Function),
    );
  });

  it("같은 followupKey의 지연 fallback은 하나만 유지한다", async () => {
    let releaseSleep!: () => void;
    const sleep = vi.fn(() => new Promise<void>((resolve) => {
      releaseSleep = resolve;
    }));
    const addIntervention = vi.fn(async () => ({ autoResumed: true as const }));
    const controller = new ClaudeRuntimeTaskFollowupController({
      taskManager: { addIntervention },
      onResume: vi.fn(),
      logger: silentLogger,
      sleep,
    });
    const task = makeTask();
    task.executionPromise = Promise.resolve();
    const message = {
      text: "retry once",
      user: "system",
      source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
      followupAttempt: 1,
      followupKey: "sess-1:task-1",
    };

    const first = controller.queueFallback(task, message, "empty_response");
    const duplicate = controller.queueFallback(task, message, "empty_response");
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1));
    releaseSleep();
    await Promise.all([first, duplicate]);

    expect(addIntervention).toHaveBeenCalledTimes(1);
  });

  it("지연 중 비-followup 메시지가 먼저 시작되면 예약을 취소한다", async () => {
    let releaseSleep!: () => void;
    const sleep = vi.fn(() => new Promise<void>((resolve) => {
      releaseSleep = resolve;
    }));
    const addIntervention = vi.fn(async () => ({ autoResumed: true as const }));
    const controller = new ClaudeRuntimeTaskFollowupController({
      taskManager: { addIntervention },
      onResume: vi.fn(),
      logger: silentLogger,
      sleep,
    });
    const task = makeTask();
    task.executionPromise = Promise.resolve();
    const scheduled = controller.queueFallback(
      task,
      {
        text: "delayed retry",
        user: "system",
        source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
        followupAttempt: 1,
        followupKey: "sess-1:task-1",
      },
      "empty_response",
    );
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1));

    controller.cancelScheduledFallback(task, {
      text: "?",
      user: "alice",
      callerInfo: { source: "soul-app", display_name: "Alice" },
    });
    releaseSleep();
    await scheduled;

    expect(addIntervention).not.toHaveBeenCalled();
    expect(task.pendingClaudeRuntimeFollowupRetry).toBe(false);
  });

  it("graceful shutdown은 인메모리 예약을 회수해 명시 실패로 넘긴다", async () => {
    let releaseSleep!: () => void;
    const sleep = vi.fn(() => new Promise<void>((resolve) => {
      releaseSleep = resolve;
    }));
    const addIntervention = vi.fn(async () => ({ autoResumed: true as const }));
    const controller = new ClaudeRuntimeTaskFollowupController({
      taskManager: { addIntervention },
      onResume: vi.fn(),
      logger: silentLogger,
      sleep,
    });
    const task = makeTask();
    task.executionPromise = Promise.resolve();
    const message = {
      text: "delayed retry",
      user: "system",
      source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
      followupAttempt: 1,
      followupKey: "sess-1:task-1",
    };
    const scheduled = controller.queueFallback(task, message, "empty_response");
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1));

    expect(controller.takeScheduledFallbacks()).toEqual([
      { task, message, reason: "empty_response" },
    ]);
    releaseSleep();
    await scheduled;

    expect(addIntervention).not.toHaveBeenCalled();
    expect(task.pendingClaudeRuntimeFollowupRetry).toBe(false);
  });
});
