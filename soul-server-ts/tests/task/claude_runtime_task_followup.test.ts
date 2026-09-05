import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { markPostResultDrainEvent } from "../../src/engine/claude_event_phase.js";
import { attachClaudeSdkSessionMetadata } from
  "../../src/engine/claude_sdk_session_metadata.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";
import {
  CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
  ClaudeRuntimeTaskFollowupController,
} from "../../src/task/claude_runtime_task_followup.js";
import type { Task } from "../../src/task/task_models.js";
import { buildClaudeBackgroundGenerationIdentity } from
  "../../src/task/claude_background_generation_identity.js";

const silentLogger = pino({ level: "silent" });

function makeTask(): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "running",
    profileId: "claude-roselin",
    codexThreadId: "sdk-sess-1",
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

function makeController(
  deliveryV2Enabled = false,
  recordInlineConsumed?: ReturnType<typeof vi.fn>,
) {
  const addIntervention = vi.fn(async () => ({ queued: true, queuePosition: 1 }));
  const onResume = vi.fn();
  const releaseRetainedRunner = vi.fn(async () => undefined);
  const subject = new ClaudeRuntimeTaskFollowupController({
    taskManager: { addIntervention },
    onResume,
    logger: silentLogger,
    releaseRetainedRunner,
    deliveryV2Enabled,
    sourceNode: "node-1",
    // Legacy dependency is deliberately injected: producer observation must not consume.
    inlineConsumptionRecorder: recordInlineConsumed
      ? { recordInlineConsumed }
      : undefined,
  } as never);
  const withGeneration = (event: SSEEventPayload): SSEEventPayload => {
    const payload = event as Record<string, unknown>;
    const taskId = typeof payload.task_id === "string" ? payload.task_id : undefined;
    if (!taskId || !String(payload.type).startsWith("claude_runtime_task_")) {
      return event;
    }
    const patch = payload.patch && typeof payload.patch === "object"
      ? payload.patch as Record<string, unknown>
      : undefined;
    return {
      ...payload,
      session_id: payload.session_id ?? "sdk-sess-1",
      ...(payload.tool_use_id || patch?.tool_use_id
        ? {}
        : { tool_use_id: `toolu-${taskId}` }),
    } as SSEEventPayload;
  };
  const controller = {
    collect: (task: Task, event: SSEEventPayload) =>
      subject.collect(task, withGeneration(event)),
    flush: (task: Task) => subject.flush(task),
    collectDetached: (task: Task, event: SSEEventPayload) =>
      subject.collectDetached(task, withGeneration(event)),
  };
  return {
    controller,
    addIntervention,
    onResume,
    releaseRetainedRunner,
  };
}

describe("ClaudeRuntimeTaskFollowupController", () => {
  it("runner metadata의 실제 SDK session을 canonical generation 경계로 검증한다", async () => {
    const task = makeTask();
    task.claudeRuntime!.tasks["task-metadata-session"] = {
      taskId: "task-metadata-session",
      status: "completed",
      updatedAt: 70,
      isBackgrounded: true,
      toolUseId: "toolu-metadata-session",
    };
    const addIntervention = vi.fn(async () => ({ queued: true, queuePosition: 1 }));
    const controller = new ClaudeRuntimeTaskFollowupController({
      taskManager: { addIntervention },
      onResume: vi.fn(),
      logger: silentLogger,
      releaseRetainedRunner: vi.fn(async () => undefined),
      deliveryV2Enabled: true,
      sourceNode: "node-1",
    });
    const event = {
      type: "claude_runtime_task_notification",
      task_id: "task-metadata-session",
      tool_use_id: "toolu-metadata-session",
      status: "completed",
      _event_id: 70,
    } as SSEEventPayload;
    attachClaudeSdkSessionMetadata(event, { sessionId: "sdk-sess-1" });

    controller.collect(task, event);
    await controller.flush(task);

    const expected = buildClaudeBackgroundGenerationIdentity({
      sourceNode: "node-1",
      agentSessionId: "sess-1",
      sdkSessionId: "sdk-sess-1",
      sdkTaskId: "task-metadata-session",
      initiatingToolUseId: "toolu-metadata-session",
    });
    expect(addIntervention).toHaveBeenCalledOnce();
    expect(addIntervention.mock.calls[0]![0]).toMatchObject({
      relationKey: expected.relationKey,
      completionId: expected.completionId,
      deliveryId: expected.deliveryId,
    });
  });

  it("stale projection A가 native terminal B의 generation을 덮지 않는다", async () => {
    const task = makeTask();
    task.claudeRuntime!.tasks["shared-task"] = {
      taskId: "shared-task",
      status: "completed",
      updatedAt: 123,
      isBackgrounded: true,
      toolUseId: "toolu-A",
      summary: "stale A",
    };
    const { controller, addIntervention } = makeController(true);

    controller.collect(task, {
      type: "claude_runtime_task_notification",
      task_id: "shared-task",
      session_id: "sdk-sess-1",
      tool_use_id: "toolu-B",
      status: "completed",
      summary: "fresh B",
      _event_id: 77,
    } as SSEEventPayload);
    await controller.flush(task);

    const expected = buildClaudeBackgroundGenerationIdentity({
      sourceNode: "node-1",
      agentSessionId: "sess-1",
      sdkSessionId: "sdk-sess-1",
      sdkTaskId: "shared-task",
      initiatingToolUseId: "toolu-B",
    });
    expect(addIntervention).toHaveBeenCalledOnce();
    expect(addIntervention.mock.calls[0]![0]).toMatchObject({
      relationKey: expected.relationKey,
      completionId: expected.completionId,
      deliveryId: expected.deliveryId,
    });
    expect(addIntervention.mock.calls[0]![0].text).toContain("fresh B");
    expect(addIntervention.mock.calls[0]![0].text).not.toContain("stale A");
  });

  it("같은 task id의 A와 실제 resume B를 각각 한 번 전달하고 stopped→killed는 보강만 한다", async () => {
    const task = makeTask();
    const { controller, addIntervention } = makeController(true);
    task.claudeRuntime!.tasks["shared-task"] = {
      taskId: "shared-task",
      status: "stopped",
      updatedAt: 10,
      isBackgrounded: true,
      toolUseId: "toolu-A",
    };
    controller.collect(task, {
      type: "claude_runtime_task_notification",
      task_id: "shared-task",
      session_id: "sdk-sess-1",
      tool_use_id: "toolu-A",
      status: "stopped",
      _event_id: 10,
    } as SSEEventPayload);
    await controller.flush(task);
    controller.collect(task, {
      type: "claude_runtime_task_updated",
      task_id: "shared-task",
      session_id: "sdk-sess-1",
      patch: { status: "killed", tool_use_id: "toolu-A", end_time: 11 },
      _event_id: 11,
    } as SSEEventPayload);
    await controller.flush(task);

    task.claudeRuntime!.tasks["shared-task"] = {
      taskId: "shared-task",
      status: "completed",
      updatedAt: 20,
      isBackgrounded: true,
      toolUseId: "toolu-B",
    };
    controller.collect(task, {
      type: "claude_runtime_task_notification",
      task_id: "shared-task",
      session_id: "sdk-sess-1",
      tool_use_id: "toolu-B",
      status: "completed",
      _event_id: 20,
    } as SSEEventPayload);
    await controller.flush(task);

    expect(addIntervention).toHaveBeenCalledTimes(2);
    expect(addIntervention.mock.calls.map((call) => call[0].relationKey)).toEqual([
      expect.stringContaining("toolu-A"),
      expect.stringContaining("toolu-B"),
    ]);
  });
  it("foreground Bash/Agent task_notification은 follow-up으로 승격하지 않는다", async () => {
    for (const taskType of ["bash", "agent"]) {
      const task = makeTask();
      task.claudeRuntime!.tasks[`foreground-${taskType}`] = {
        taskId: `foreground-${taskType}`,
        status: "completed",
        updatedAt: Date.now(),
        taskType,
      };
      const { controller, addIntervention } = makeController(true);

      controller.collect(task, {
        type: "claude_runtime_task_notification",
        task_id: `foreground-${taskType}`,
        status: "completed",
        summary: "already consumed synchronously",
      } as SSEEventPayload);
      await controller.flush(task);

      expect(addIntervention).not.toHaveBeenCalled();
    }
  });

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
    const expected = buildClaudeBackgroundGenerationIdentity({
      sourceNode: "node-1",
      agentSessionId: "sess-1",
      sdkSessionId: "sdk-sess-1",
      sdkTaskId: "task-1",
      initiatingToolUseId: "toolu-task-1",
    });
    expect(addIntervention).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: "sess-1",
        user: "system",
        source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
        followupAttempt: 1,
        followupKey: `sess-1:${expected.generationKey}`,
        text: expect.stringContaining("task-1"),
      }),
      onResume,
    );
    const text = addIntervention.mock.calls[0]![0].text;
    expect(text).toContain("/tmp/task-1.output");
    expect(text).toContain("uploaded wav files");
    expect(text).toContain("직전 응답을 그대로 반복하지 마세요");
  });

  it("v2는 canonical generation 기반 stable runtime_followup identity를 전달한다", async () => {
    const task = makeTask();
    task.claudeRuntime!.tasks["task-v2"] = {
      taskId: "task-v2",
      status: "completed",
      updatedAt: 123,
      isBackgrounded: true,
      summary: "done",
    };
    const { controller, addIntervention } = makeController(true);

    controller.collect(task, {
      type: "claude_runtime_task_notification",
      task_id: "task-v2",
      status: "completed",
      summary: "done",
      _event_id: 77,
    } as SSEEventPayload);
    await controller.flush(task);

    const params = addIntervention.mock.calls[0]![0];
    const expected = buildClaudeBackgroundGenerationIdentity({
      sourceNode: "node-1",
      agentSessionId: "sess-1",
      sdkSessionId: "sdk-sess-1",
      sdkTaskId: "task-v2",
      initiatingToolUseId: "toolu-task-v2",
    });
    expect(params).toMatchObject({
      deliveryIntent: "runtime_followup",
      source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
      producerTerminalRevision: "77",
      deliveryId: expected.deliveryId,
      relationKey: expected.relationKey,
      completionId: expected.completionId,
    });
    expect(params.deliveryId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("producer가 inline으로 관측한 runtime 완료도 exact next-turn delivery로 전달한다", async () => {
    const task = makeTask();
    task.lastEventId = 91;
    task.claudeRuntime!.tasks["task-inline"] = {
      taskId: "task-inline",
      status: "completed",
      updatedAt: 77,
      isBackgrounded: true,
      summary: "already reflected inline",
    };
    const recordInlineConsumed = vi.fn().mockResolvedValue(true);
    const { controller, addIntervention, onResume, releaseRetainedRunner } =
      makeController(true, recordInlineConsumed);
    const event = {
      type: "claude_runtime_task_notification",
      task_id: "task-inline",
      status: "completed",
      summary: "already reflected inline",
      _event_id: 77,
    } as SSEEventPayload;

    controller.collect(task, event);
    await controller.flush(task);
    await controller.collectDetached(task, markPostResultDrainEvent(event));

    expect(recordInlineConsumed).not.toHaveBeenCalled();
    expect(addIntervention).toHaveBeenCalledOnce();
    expect(addIntervention).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: "sess-1",
        deliveryIntent: "runtime_followup",
        relationKey: expect.stringContaining("toolu-task-inline"),
      }),
      onResume,
    );
    expect(onResume).not.toHaveBeenCalled();
    expect(releaseRetainedRunner).toHaveBeenCalledOnce();
    expect(releaseRetainedRunner).toHaveBeenCalledWith(task);
  });

  it("foreground Result 뒤 detached 완료는 terminal caller에 정확히 한 번 전달한다", async () => {
    const task = makeTask();
    task.status = "completed";
    task.claudeRuntime!.tasks["task-after-result"] = {
      taskId: "task-after-result",
      status: "completed",
      updatedAt: 78,
      isBackgrounded: true,
    };
    const recordInlineConsumed = vi.fn().mockResolvedValue(true);
    const { controller, addIntervention } =
      makeController(true, recordInlineConsumed);
    const event = markPostResultDrainEvent({
      type: "claude_runtime_task_notification",
      task_id: "task-after-result",
      status: "completed",
      _event_id: 78,
    } as SSEEventPayload);

    await controller.collectDetached(task, event);
    await controller.collectDetached(task, event);

    expect(recordInlineConsumed).not.toHaveBeenCalled();
    expect(addIntervention).toHaveBeenCalledTimes(1);
    expect(addIntervention).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: "sess-1",
        deliveryIntent: "runtime_followup",
      }),
      expect.any(Function),
    );
  });

  it("복수 background task는 마지막 terminal까지 runner follow-up을 보류한다", async () => {
    const task = makeTask();
    task.status = "completed";
    task.claudeRuntime!.tasks["task-first"] = {
      taskId: "task-first",
      status: "completed",
      updatedAt: 78,
      isBackgrounded: true,
    };
    task.claudeRuntime!.tasks["task-last"] = {
      taskId: "task-last",
      status: "running",
      updatedAt: 79,
      isBackgrounded: true,
    };
    const { controller, addIntervention } = makeController(true);

    await controller.collectDetached(task, markPostResultDrainEvent({
      type: "claude_runtime_task_notification",
      task_id: "task-first",
      status: "completed",
      _event_id: 78,
    } as SSEEventPayload));

    expect(addIntervention).not.toHaveBeenCalled();

    task.claudeRuntime!.tasks["task-last"]!.status = "completed";
    await controller.collectDetached(task, markPostResultDrainEvent({
      type: "claude_runtime_task_notification",
      task_id: "task-last",
      status: "completed",
      _event_id: 80,
    } as SSEEventPayload));

    expect(addIntervention).toHaveBeenCalledTimes(2);
    expect(addIntervention.mock.calls.map((call) => call[0].followupTaskIds)).toEqual([
      ["task-first"],
      ["task-last"],
    ]);
  });

  it("foreground flush도 background runtime task가 남아 있으면 follow-up을 시작하지 않는다", async () => {
    const task = makeTask();
    task.claudeRuntime!.tasks["task-complete"] = {
      taskId: "task-complete",
      status: "completed",
      updatedAt: 78,
      isBackgrounded: true,
    };
    task.claudeRuntime!.tasks["task-running"] = {
      taskId: "task-running",
      status: "running",
      updatedAt: 79,
      isBackgrounded: true,
    };
    const { controller, addIntervention } = makeController(true);

    controller.collect(task, {
      type: "claude_runtime_task_notification",
      task_id: "task-complete",
      status: "completed",
      _event_id: 78,
    } as SSEEventPayload);
    await controller.flush(task);

    expect(addIntervention).not.toHaveBeenCalled();
    task.claudeRuntime!.tasks["task-running"]!.status = "completed";
    await controller.flush(task);
    expect(addIntervention).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "stopped", "killed"] as const)(
    "마지막 background %s terminal도 보류된 task를 함께 flush한다",
    async (terminalStatus) => {
      const task = makeTask();
      task.status = "completed";
      task.claudeRuntime!.tasks["task-first"] = {
        taskId: "task-first",
        status: "completed",
        updatedAt: 78,
        isBackgrounded: true,
      };
      task.claudeRuntime!.tasks["task-last"] = {
        taskId: "task-last",
        status: "running",
        updatedAt: 79,
        isBackgrounded: true,
      };
      const { controller, addIntervention } = makeController(true);

      await controller.collectDetached(task, markPostResultDrainEvent({
        type: "claude_runtime_task_notification",
        task_id: "task-first",
        status: "completed",
        _event_id: 78,
      } as SSEEventPayload));
      task.claudeRuntime!.tasks["task-last"]!.status = terminalStatus;
      await controller.collectDetached(task, markPostResultDrainEvent({
        type: "claude_runtime_task_notification",
        task_id: "task-last",
        status: terminalStatus,
        _event_id: 80,
      } as SSEEventPayload));

      expect(addIntervention).toHaveBeenCalledTimes(2);
      expect(addIntervention.mock.calls[1]![0].text).toContain(`status=${terminalStatus}`);
    },
  );

  it("interrupt 중에는 follow-up을 보류하고 다음 running turn까지 pending을 보존한다", async () => {
    const task = makeTask();
    task.claudeRuntime!.tasks["task-interrupted"] = {
      taskId: "task-interrupted",
      status: "completed",
      updatedAt: Date.now(),
      isBackgrounded: true,
      summary: "completed while interrupting",
    };
    const { controller, addIntervention } = makeController();

    controller.collect(task, {
      type: "claude_runtime_task_notification",
      task_id: "task-interrupted",
      status: "completed",
      summary: "completed while interrupting",
    } as SSEEventPayload);
    task.status = "interrupted";

    await controller.flush(task);

    expect(addIntervention).not.toHaveBeenCalled();

    task.status = "running";
    await controller.flush(task);

    expect(addIntervention).toHaveBeenCalledTimes(1);
    expect(addIntervention.mock.calls[0]![0]).toMatchObject({
      agentSessionId: "sess-1",
      followupTaskIds: ["task-interrupted"],
    });
  });

  it("동기 local_agent terminal notification은 background 근거 없이 follow-up하지 않는다", async () => {
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

    expect(addIntervention).not.toHaveBeenCalled();
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
        patch: {
          status: task.claudeRuntime!.tasks[taskId]!.status,
          tool_use_id: task.claudeRuntime!.tasks[taskId]!.toolUseId,
        },
      } as unknown as SSEEventPayload);
    }
    await controller.flush(task);

    expect(addIntervention).toHaveBeenCalledTimes(3);
    const text = addIntervention.mock.calls.map((call) => call[0].text).join("\n");
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
      releaseRetainedRunner: async () => undefined,
      logger: silentLogger,
      sourceNode: "node-1",
    });

    controller.collect(task, {
      type: "claude_runtime_task_notification",
      task_id: "task-retry",
      status: "completed",
      summary: "retry me",
      session_id: "sdk-sess-1",
      tool_use_id: "toolu-task-retry",
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
    expect(params.followupKey).toContain("toolu-task-2");
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
    expect((text.match(/task_id=task-3/g) ?? [])).toHaveLength(1);
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

  it("같은 turn의 여러 완료 task도 generation별 delivery로 분리한다", async () => {
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

    expect(addIntervention).toHaveBeenCalledTimes(2);
    expect(addIntervention.mock.calls[0]![0].text).toContain("task-a");
    expect(addIntervention.mock.calls[1]![0].text).toContain("task-b");
    expect(addIntervention.mock.calls[0]![0].text).toContain("first done");
    expect(addIntervention.mock.calls[1]![0].text).toContain("second done");
    expect(addIntervention.mock.calls[0]![0].followupKey).toContain("toolu-task-a");
    expect(addIntervention.mock.calls[1]![0].followupKey).toContain("toolu-task-b");
  });

});
