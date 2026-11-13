import { createHash } from "node:crypto";

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { attachClaudeBackgroundDeliveryMetadata } from
  "../../src/engine/claude_background_delivery_metadata.js";
import { attachClaudeBackgroundProvenance } from
  "../../src/engine/claude_background_provenance.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";
import { buildClaudeBackgroundGenerationIdentity } from
  "../../src/task/claude_background_generation_identity.js";
import {
  CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
  ClaudeRuntimeTaskFollowupController,
} from "../../src/task/claude_runtime_task_followup.js";
import { TaskCompletionNotifier } from "../../src/task/completion_notifier.js";
import { TaskExecutorFinalizer } from "../../src/task/task_executor_finalizer.js";
import { TaskLifecycleTransition } from "../../src/task/task_lifecycle_transition.js";
import type { Task } from "../../src/task/task_models.js";
import { makeDeliveryRepository } from "./delivery_repository_test_fake.js";

const silentLogger = pino({ level: "silent" });

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "agent-child",
    prompt: "run background",
    status: "running",
    profileId: "claude-roselin",
    callerSessionId: "agent-caller",
    codexThreadId: "sdk-session-1",
    createdAt: new Date("2026-11-13T00:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
    claudeRuntime: { sessionState: "idle", updatedAt: 1, tasks: {} },
    ...overrides,
  };
}

function makeRunner(activity: {
  backgroundTaskCount: number;
  pendingRuntimeSignalCount?: number;
}) {
  const dispatcher = {
    close: vi.fn(async () => undefined),
    hasClosedEngineFailureForFinalization: () => false,
    hasLostRunner: () => false,
    registrationId: () => "registration-1",
  };
  const engine = {
    backendId: "claude",
    workspaceDir: "/tmp/claude-persistent",
    detachedClaudeRuntime: true,
    detachedClaudeRuntimeActivity: async () => activity,
    async *execute() {},
    async interrupt() { return true; },
    async close() {},
  };
  return { dispatcher, engine } as unknown as NonNullable<Task["runner"]> & {
    dispatcher: { close: ReturnType<typeof vi.fn> };
  };
}

/** SDK-membership completion carrying the durable delivery identity it settles. */
function nativeTerminal(task: Task, taskId: string, toolUseId: string): SSEEventPayload {
  const identity = buildClaudeBackgroundGenerationIdentity({
    sourceNode: "node-1",
    agentSessionId: task.agentSessionId,
    sdkSessionId: task.codexThreadId!,
    sdkTaskId: taskId,
    initiatingToolUseId: toolUseId,
  });
  const event = {
    type: "claude_runtime_task_updated",
    task_id: taskId,
    tool_use_id: toolUseId,
    session_id: task.codexThreadId,
    patch: { status: "completed", is_backgrounded: true },
  } as unknown as SSEEventPayload;
  attachClaudeBackgroundProvenance(event, "sdk_membership");
  attachClaudeBackgroundDeliveryMetadata(event, {
    initiatingToolUseId: toolUseId,
    deliveryId: identity.deliveryId,
    completionId: identity.completionId,
    relationKey: identity.relationKey,
    producerTerminalRevision: "1",
    deliveryCreatedAt: "2026-11-13T00:00:00.000Z",
    source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
    storedPayload: { text: `${taskId} background done`, user: "system" },
    storedPayloadHash: "hash",
  });
  return event;
}

function makeNotifier(addIntervention: ReturnType<typeof vi.fn>) {
  return new TaskCompletionNotifier(
    "node-1",
    { addIntervention } as never,
    { get: () => undefined } as never,
    vi.fn(),
    silentLogger,
  );
}

describe("Claude background follow-up regression", () => {
  it("T1: 시한이 지나면 보유를 풀지 않은 채 followup이 자동 재개된다 (#1265)", async () => {
    vi.useFakeTimers();
    try {
      const task = makeTask({
        status: "completed",
        runnerRetainedForDetachedWork: true,
      });
      task.claudeRuntime!.tasks["task-native"] = {
        taskId: "task-native",
        status: "completed",
        updatedAt: 1,
        isBackgrounded: true,
        toolUseId: "toolu-native",
      };
      const addIntervention = vi.fn(async () => ({ autoResumed: true }));
      const releaseRetainedRunner = vi.fn(async () => undefined);
      const notifyBackgroundStopped = vi.fn(async () => undefined);
      const controller = new ClaudeRuntimeTaskFollowupController({
        taskManager: { addIntervention },
        onResume: vi.fn(),
        releaseRetainedRunner,
        notifyBackgroundStopped,
        logger: silentLogger,
        deliveryV2Enabled: true,
        sourceNode: "node-1",
        followupDeadlineMs: 120_000,
      } as never);

      await controller.collectDetached(task, nativeTerminal(task, "task-native", "toolu-native"));

      // The SDK-native notification turn owns the delivery for now, and the
      // retained runner may not be released while the follow-up is owed.
      expect(addIntervention).not.toHaveBeenCalled();
      expect(releaseRetainedRunner).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(119_999);
      expect(addIntervention).not.toHaveBeenCalled();
      expect(releaseRetainedRunner).not.toHaveBeenCalled();

      // The notification turn never became a Soulstream turn: the deadline
      // sends the follow-up anyway so the session runs again.
      await vi.advanceTimersByTimeAsync(1);
      expect(addIntervention).toHaveBeenCalledOnce();
      const intervention = addIntervention.mock.calls[0]![0] as {
        agentSessionId: string;
        source: string;
        followupKey: string;
        text: string;
      };
      expect(intervention.agentSessionId).toBe("agent-child");
      expect(intervention.source).toBe(CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE);
      expect(intervention.followupKey).toContain("task-native");
      expect(intervention.text).toContain("task-native");
      // followup으로 이어 간 세대는 「이을 수 없음」 알림을 만들지 않는다.
      expect(notifyBackgroundStopped).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("T2: 보유가 선 세션은 이어서 보고한다 줄을 받고 완료 뒤 다시 돈다 (#1261)", async () => {
    vi.useFakeTimers();
    try {
      const addIntervention = vi.fn(async (..._args: unknown[]) => ({ autoResumed: true }));
      const notifier = makeNotifier(addIntervention);
      const task = makeTask({ status: "running" });
      task.claudeRuntime!.tasks["bg-seal"] = {
        taskId: "bg-seal",
        status: "running",
        updatedAt: 1,
        isBackgrounded: true,
        toolUseId: "toolu-seal",
      };
      const runner = makeRunner({ backgroundTaskCount: 1, pendingRuntimeSignalCount: 0 });
      task.runner = runner;
      const lifecycle = {
        persistExecutorFinalState: vi.fn(async () => ({
          newlyFinalized: true,
          terminalTransitionApplied: true,
        })),
        notifyCompletionIfApplied: vi.fn(async (target: Task) => {
          await notifier.notify(target);
        }),
      };
      const finalizer = new TaskExecutorFinalizer({
        lifecycleTransition: lifecycle as never,
        logger: silentLogger,
      });

      await finalizer.finalize(task);

      // R4: 남은 백그라운드와 함께 끝났고 보유가 섰다.
      expect(task.runnerRetainedForDetachedWork).toBe(true);
      expect(addIntervention).toHaveBeenCalledOnce();
      const completion = addIntervention.mock.calls[0]![0] as {
        agentSessionId: string;
        text: string;
      };
      expect(completion.agentSessionId).toBe("agent-caller");
      expect(completion.text).toContain("백그라운드 작업 1개가 아직 돌고 있습니다");
      expect(completion.text).toContain("이어서 다시 보고합니다(최대 60분)");

      // The detached completion arrives while the runner is retained.
      task.claudeRuntime!.tasks["bg-seal"]!.status = "completed";
      const controller = new ClaudeRuntimeTaskFollowupController({
        taskManager: { addIntervention },
        onResume: vi.fn(),
        releaseRetainedRunner: async (target: Task) =>
          await finalizer.releaseRetainedClaudeRunner(target),
        logger: silentLogger,
        deliveryV2Enabled: true,
        sourceNode: "node-1",
        followupDeadlineMs: 120_000,
      } as never);
      await controller.collectDetached(task, nativeTerminal(task, "bg-seal", "toolu-seal"));
      await vi.advanceTimersByTimeAsync(120_000);

      // The follow-up auto-resumes the same session.
      expect(addIntervention).toHaveBeenCalledTimes(2);
      const followup = addIntervention.mock.calls[1]![0] as {
        agentSessionId: string;
        source: string;
      };
      expect(followup.agentSessionId).toBe("agent-child");
      expect(followup.source).toBe(CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE);

      // The resumed turn ends without background and reports once more.
      task.status = "completed";
      task.runner = undefined;
      task.runnerRetainedForDetachedWork = undefined;
      task.backgroundRuntimeAtTurnEnd = undefined;
      task.lastAssistantText = "follow-up handled";
      await finalizer.finalize(task);

      expect(addIntervention).toHaveBeenCalledTimes(3);
      const second = addIntervention.mock.calls[2]![0] as {
        agentSessionId: string;
        text: string;
      };
      expect(second.agentSessionId).toBe("agent-caller");
      expect(second.text).toContain("follow-up handled");
      expect(second.text).not.toContain("이어서 다시 보고합니다");
    } finally {
      vi.useRealTimers();
    }
  });

  it("T3a: 완료를 followup으로 이을 수 없어 보유가 풀리면 멈춤 알림을 보낸다 (R5)", async () => {
    vi.useFakeTimers();
    try {
      const task = makeTask({
        status: "completed",
        runnerRetainedForDetachedWork: true,
      });
      const addIntervention = vi.fn(async () => ({ autoResumed: true }));
      const notifyBackgroundStopped = vi.fn(async () => undefined);
      const releaseRetainedRunner = vi.fn(async (target: Task) => {
        target.runnerRetainedForDetachedWork = undefined;
      });
      const controller = new ClaudeRuntimeTaskFollowupController({
        taskManager: { addIntervention },
        onResume: vi.fn(),
        releaseRetainedRunner,
        notifyBackgroundStopped,
        logger: silentLogger,
        deliveryV2Enabled: true,
        sourceNode: "node-1",
        followupDeadlineMs: 120_000,
      } as never);
      // V2가 신원을 세우지 못하는 완료 사건(sdk_membership인데 durable metadata 없음).
      const lost = {
        type: "claude_runtime_task_updated",
        task_id: "task-lost",
        session_id: "sdk-session-1",
        patch: { status: "completed", is_backgrounded: true },
      } as unknown as SSEEventPayload;
      attachClaudeBackgroundProvenance(lost, "sdk_membership");

      await controller.collectDetached(task, lost);

      // 식별 없는 사건은 뒤이은 알림이 세대를 세울 수 있어 시한까지 기다린다(B).
      expect(releaseRetainedRunner).not.toHaveBeenCalled();
      expect(notifyBackgroundStopped).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(addIntervention).not.toHaveBeenCalled();
      expect(releaseRetainedRunner).toHaveBeenCalledOnce();
      expect(task.runnerRetainedForDetachedWork).toBeUndefined();
      expect(notifyBackgroundStopped).toHaveBeenCalledOnce();
      expect(notifyBackgroundStopped).toHaveBeenCalledWith(
        task,
        "백그라운드 작업이 끝났지만 이 세션을 이어 갈 수 없어 멈췄습니다.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("B1: 식별 없는 터미널 사건 뒤 시한 안에 세대가 서면 followup이 가고 멈춤 알림이 없다", async () => {
    vi.useFakeTimers();
    try {
      const task = makeTask({
        status: "completed",
        runnerRetainedForDetachedWork: true,
      });
      const addIntervention = vi.fn(async () => ({ autoResumed: true }));
      const notifyBackgroundStopped = vi.fn(async () => undefined);
      const releaseRetainedRunner = vi.fn(async (target: Task) => {
        target.runnerRetainedForDetachedWork = undefined;
      });
      const controller = new ClaudeRuntimeTaskFollowupController({
        taskManager: { addIntervention },
        onResume: vi.fn(),
        releaseRetainedRunner,
        notifyBackgroundStopped,
        logger: silentLogger,
        deliveryV2Enabled: true,
        sourceNode: "node-1",
        followupDeadlineMs: 120_000,
      } as never);
      // 메타데이터 없는 터미널 사건 — 이 시점에는 세대가 서지 않는다.
      const lost = {
        type: "claude_runtime_task_updated",
        task_id: "task-late",
        session_id: "sdk-session-1",
        patch: { status: "completed", is_backgrounded: true },
      } as unknown as SSEEventPayload;
      attachClaudeBackgroundProvenance(lost, "sdk_membership");
      await controller.collectDetached(task, lost);

      // 시한 전에는 풀지도, 멈춤을 알리지도 않는다.
      expect(releaseRetainedRunner).not.toHaveBeenCalled();
      expect(notifyBackgroundStopped).not.toHaveBeenCalled();

      // 시한 안에 tool_use_id를 가진 알림이 와서 같은 작업의 세대를 세운다.
      await controller.collectDetached(task, nativeTerminal(task, "task-late", "toolu-late"));
      await vi.advanceTimersByTimeAsync(120_000);

      // followup이 자동 재개로 가고, 멈춤 알림은 한 번도 나가지 않는다.
      expect(addIntervention).toHaveBeenCalledOnce();
      const followup = addIntervention.mock.calls[0]![0] as {
        agentSessionId: string;
        source: string;
      };
      expect(followup.agentSessionId).toBe("agent-child");
      expect(followup.source).toBe(CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE);
      expect(notifyBackgroundStopped).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("B2: 식별 없는 터미널 사건만 있으면 시한 뒤에 멈춤 알림을 정확히 한 번 보낸다", async () => {
    vi.useFakeTimers();
    try {
      const task = makeTask({
        status: "completed",
        runnerRetainedForDetachedWork: true,
      });
      const addIntervention = vi.fn(async () => ({ autoResumed: true }));
      const notifyBackgroundStopped = vi.fn(async () => undefined);
      const releaseRetainedRunner = vi.fn(async (target: Task) => {
        target.runnerRetainedForDetachedWork = undefined;
      });
      const controller = new ClaudeRuntimeTaskFollowupController({
        taskManager: { addIntervention },
        onResume: vi.fn(),
        releaseRetainedRunner,
        notifyBackgroundStopped,
        logger: silentLogger,
        deliveryV2Enabled: true,
        sourceNode: "node-1",
        followupDeadlineMs: 120_000,
      } as never);
      const lost = {
        type: "claude_runtime_task_updated",
        task_id: "task-lived",
        session_id: "sdk-session-1",
        patch: { status: "completed", is_backgrounded: true },
      } as unknown as SSEEventPayload;
      attachClaudeBackgroundProvenance(lost, "sdk_membership");
      await controller.collectDetached(task, lost);

      await vi.advanceTimersByTimeAsync(119_999);
      expect(releaseRetainedRunner).not.toHaveBeenCalled();
      expect(notifyBackgroundStopped).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(releaseRetainedRunner).toHaveBeenCalledOnce();
      expect(notifyBackgroundStopped).toHaveBeenCalledOnce();
      expect(notifyBackgroundStopped).toHaveBeenCalledWith(
        task,
        "백그라운드 작업이 끝났지만 이 세션을 이어 갈 수 없어 멈췄습니다.",
      );
      expect(addIntervention).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("T3b: V2에서 완료 알림과 멈춤 알림은 겹치지 않는 전달로 둘 다 남는다", async () => {
    const addIntervention = vi.fn(async () => ({ queued: true, queuePosition: 1 }));
    const rows = new Map<string, Record<string, unknown>>();
    const repository = makeDeliveryRepository(rows);
    const notifier = new TaskCompletionNotifier(
      "node-1",
      { addIntervention } as never,
      { get: () => undefined } as never,
      vi.fn(),
      silentLogger,
      undefined,
      undefined,
      undefined,
      true,
      repository as never,
    );
    const task = makeTask({
      status: "completed",
      terminalEventId: 5,
      completedAt: new Date("2026-11-13T00:10:00.000Z"),
    });

    await notifier.notify(task);
    await notifier.notifyBackgroundStopped(task, "백그라운드 작업이 60분 안에 끝나지 않아 멈췄습니다.");
    await notifier.notifyBackgroundStopped(task, "백그라운드 작업이 60분 안에 끝나지 않아 멈췄습니다.");

    expect(addIntervention).toHaveBeenCalledTimes(2);
    const completion = addIntervention.mock.calls[0]![0] as {
      deliveryId: string;
      relationKey: string;
      text: string;
    };
    const stopped = addIntervention.mock.calls[1]![0] as {
      deliveryId: string;
      relationKey: string;
      text: string;
    };
    expect(completion.relationKey).toBe("child_session:agent-child:5");
    expect(stopped.relationKey).toBe(
      "child_session:agent-child:5:background_stopped:"
      + createHash("sha256")
        .update("백그라운드 작업이 60분 안에 끝나지 않아 멈췄습니다.")
        .digest("hex").slice(0, 16),
    );
    expect(stopped.deliveryId).not.toBe(completion.deliveryId);
    expect(stopped.text).toContain("이 세션은 더 보고하지 않습니다.");

    // 두 전달 모두 살아 있고, 완료 알림 행은 dead_letter가 아니다.
    expect(rows.size).toBe(2);
    const completionRow = [...rows.values()].find(
      (row) => row.relation_key === "child_session:agent-child:5",
    );
    expect(completionRow).toMatchObject({
      state: "claimed",
      aggregate_state: "pending",
      dead_letter_reason: null,
    });
    expect([...rows.values()].some(
      (row) => row.aggregate_state === "dead_letter",
    )).toBe(false);
  });

  it("T3: 보유 상한을 넘기면 보유를 풀고 부른 세션에 더 보고하지 않습니다를 보낸다", async () => {
    vi.useFakeTimers();
    try {
      const addIntervention = vi.fn(async () => ({ queued: true, queuePosition: 1 }));
      const notifier = makeNotifier(addIntervention);
      const lifecycle = new TaskLifecycleTransition({
        logger: silentLogger,
        completionNotifier: notifier,
      });
      const finalizer = new TaskExecutorFinalizer({
        lifecycleTransition: lifecycle,
        logger: silentLogger,
        retentionCapMs: 3_600_000,
        notifyBackgroundStopped: async (target: Task, firstSentence: string) => {
          await lifecycle.notifyBackgroundStopped(target, firstSentence);
        },
      });
      const task = makeTask({ status: "completed" });
      task.claudeRuntime!.tasks["bg-long"] = {
        taskId: "bg-long",
        status: "running",
        updatedAt: 1,
        isBackgrounded: true,
        toolUseId: "toolu-long",
      };
      const runner = makeRunner({ backgroundTaskCount: 1, pendingRuntimeSignalCount: 0 });
      task.runner = runner;

      await expect(
        finalizer.retainRunnerIfDetachedWorkActive(task, runner),
      ).resolves.toBe("retained");
      expect(task.runnerRetainedForDetachedWork).toBe(true);
      expect(addIntervention).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(3_599_999);
      expect(addIntervention).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(runner.dispatcher.close).toHaveBeenCalledOnce();
      expect(task.runnerRetainedForDetachedWork).toBeUndefined();
      expect(addIntervention).toHaveBeenCalledOnce();
      const notice = addIntervention.mock.calls[0]![0] as {
        agentSessionId: string;
        text: string;
      };
      expect(notice.agentSessionId).toBe("agent-caller");
      expect(notice.text).toBe(
        "백그라운드 작업이 60분 안에 끝나지 않아 멈췄습니다. 이 세션은 더 보고하지 않습니다.",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
