import pino from "pino";
import { SESSION_MODEL_FALLBACK_REASON } from "@soulstream/wire-schema/model-preset-fallbacks";
import { describe, expect, it, vi } from "vitest";

import { ScheduleDispatcher } from "../../src/schedule/schedule_dispatcher.js";
import type { SoulstreamSchedule } from "../../src/schedule/schedule_models.js";

const logger = pino({ level: "silent" });

function makeSchedule(overrides: Partial<SoulstreamSchedule> = {}): SoulstreamSchedule {
  return {
    scheduleId: "resume-after-limit:sess-1:32:0",
    sessionId: "sess-1",
    kind: "wakeup",
    status: "active",
    prompt: "이어서 진행해 주세요.",
    sourceTool: "ResumeAfterLimit",
    toolUseId: "ResumeAfterLimit:32",
    cronExpression: null,
    runOnceAt: null,
    timezone: "UTC",
    recurring: false,
    nextRunAt: "2026-01-01T00:00:00.000Z",
    lastFiredAt: null,
    firedCount: 0,
    dispatchFailureCount: 0,
    lastError: null,
    claimToken: null,
    claimedUntil: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeService(schedule: SoulstreamSchedule) {
  return {
    touchNodeHeartbeat: vi.fn(async () => undefined),
    repairExpiredClaims: vi.fn(async () => []),
    markOrphanDueSchedules: vi.fn(async () => []),
    restoreOrphanSchedulesForLiveNodes: vi.fn(async () => []),
    claimDueSchedules: vi.fn(async () => [{ schedule, claimToken: "claim-1" }]),
    consumeClaimedSchedule: vi.fn(async () => schedule),
    confirmScheduleStillFiring: vi.fn(async () => schedule),
    decideResumeDispatch: vi.fn(async () => ({ decision: "fire" as const, reason: null })),
    deferDispatch: vi.fn(async () => makeSchedule({ status: "active" })),
    finishDispatch: vi.fn(async () => makeSchedule({ status: "completed" })),
    failDispatch: vi.fn(async () => makeSchedule({ status: "failed" })),
  };
}

function fallbackTask() {
  return {
    agentSessionId: "sess-1",
    status: "error" as const,
    persistentGeneration: {
      number: 2,
      pending: {
        number: 2,
        reason: SESSION_MODEL_FALLBACK_REASON,
        requestedAt: "2026-01-01T00:00:00.000Z",
        targetModelPreset: "claude-opus",
      },
    },
  };
}

describe("ResumeAfterLimit dispatch failures (card #1261)", () => {
  it("does not register the parent completion again for a reservation that already did", async () => {
    // 지속 세션 한도 경로는 예약 전에 완료 전달을 등록했다. 대체 모델 표지가
    // 없으므로 다섯째 실패에도 다시 등록하면 안 된다.
    const schedule = makeSchedule({ dispatchFailureCount: 4 });
    const service = makeService(schedule);
    const task = {
      agentSessionId: "sess-1",
      status: "error" as const,
      persistentGeneration: {
        number: 2,
        pending: {
          number: 2,
          reason: "auto:limit_hit.switch",
          requestedAt: "2026-01-01T00:00:00.000Z",
          targetModelPreset: "codex-6.1-sol",
        },
      },
    };
    const taskManager = {
      getTask: vi.fn(() => task),
      resolveScheduleResumeTask: vi.fn(async () => task),
      addIntervention: vi.fn(async () => { throw new Error("session busy"); }),
    };
    const notifier = { notify: vi.fn(async () => undefined) };
    const dispatcher = new ScheduleDispatcher(
      { nodeId: "owner-node" },
      service as never,
      taskManager as never,
      vi.fn(),
      logger,
      notifier,
    );

    await dispatcher.runOnce(new Date("2026-01-01T00:00:00Z"));

    expect(notifier.notify).not.toHaveBeenCalled();
    expect(service.failDispatch).toHaveBeenCalledWith(schedule, "claim-1", "session busy");
  });

  it("loads a task evicted by a restart and registers the skipped completion once", async () => {
    const schedule = makeSchedule({ dispatchFailureCount: 4 });
    const service = makeService(schedule);
    const loaded = fallbackTask();
    const taskManager = {
      // 재시작 뒤 메모리 Map에는 없다.
      getTask: vi.fn(() => undefined),
      resolveScheduleResumeTask: vi.fn(async () => loaded),
      addIntervention: vi.fn(async () => { throw new Error("session busy"); }),
    };
    const notifier = { notify: vi.fn(async () => undefined) };
    const dispatcher = new ScheduleDispatcher(
      { nodeId: "owner-node" },
      service as never,
      taskManager as never,
      vi.fn(),
      logger,
      notifier,
    );

    await dispatcher.runOnce(new Date("2026-01-01T00:00:00Z"));

    expect(taskManager.resolveScheduleResumeTask).toHaveBeenCalledWith("sess-1");
    expect(notifier.notify).toHaveBeenCalledOnce();
    expect(notifier.notify).toHaveBeenCalledWith(loaded);
    expect(service.failDispatch).toHaveBeenCalledWith(schedule, "claim-1", "session busy");
  });

  it("defers the first failure of an old-orch row without dispatchFailureCount to 30 seconds", async () => {
    const { dispatchFailureCount: _omitted, ...legacyRow } = makeSchedule();
    const schedule = legacyRow as SoulstreamSchedule;
    const service = makeService(schedule);
    const taskManager = {
      getTask: vi.fn(() => undefined),
      resolveScheduleResumeTask: vi.fn(async () => null),
      addIntervention: vi.fn(async () => { throw new Error("session busy"); }),
    };
    const dispatcher = new ScheduleDispatcher(
      { nodeId: "owner-node" },
      service as never,
      taskManager as never,
      vi.fn(),
      logger,
    );
    const now = new Date("2026-01-01T00:00:00Z");

    await dispatcher.runOnce(now);

    const deferredAt = service.deferDispatch.mock.calls[0]?.[2] as Date;
    expect(deferredAt.getTime()).toBe(now.getTime() + 30_000);
    expect(Number.isFinite(deferredAt.getTime())).toBe(true);
    expect(service.deferDispatch).toHaveBeenCalledWith(
      schedule,
      "claim-1",
      new Date("2026-01-01T00:00:30Z"),
      "session busy",
      true,
    );
    expect(service.failDispatch).not.toHaveBeenCalled();
  });
});
