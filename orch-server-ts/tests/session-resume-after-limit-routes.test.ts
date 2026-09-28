import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  parseOrchServerConfig,
  registerSessionResumeAfterLimitRoutes,
} from "../src/index.js";
import type { SoulstreamSchedule } from "../src/schedule/schedule_types.js";
import { SessionResourceAccessError } from "../src/session/session_resource_access.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

describe("session resume-after-limit routes", () => {
  it("returns 403 before reading session state when access is denied", async () => {
    const { app, dependencies } = createHarness({
      accessError: new SessionResourceAccessError("SESSION_ACCESS_DENIED", "Access denied.", 403),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/resume-after-limit",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: { code: "SESSION_ACCESS_DENIED", message: "Access denied." },
    });
    expect(dependencies.eventReads.readRecentEvents).not.toHaveBeenCalled();
    await app.close();
  });

  it("gets the latest reset window from structured events in the current terminal turn", async () => {
    const { app, dependencies } = createHarness();

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/resume-after-limit",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      eligible: true,
      reason: null,
      resets_at: "2026-09-28T11:00:00.000Z",
      schedule: null,
    });
    expect(dependencies.accessProvider.requireSessionAccess).toHaveBeenCalledWith({
      request: expect.anything(),
      sessionId: "sess-1",
    });
    expect(dependencies.eventReads.readEventsBetween).toHaveBeenCalledWith(
      "sess-1",
      20,
      32,
      ["credential_alert", "error"],
    );
    await app.close();
  });

  it("does not infer reset time from an unstructured error message", async () => {
    const { app, dependencies } = createHarness({ currentTurnEvents: [
      event(29, "error", { message: "rate limit resets at 2026-09-28T11:00:00Z" }),
    ] });

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/sess-1/resume-after-limit",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      eligible: false,
      reason: expect.any(String),
      resets_at: null,
      schedule: null,
    });
    expect(dependencies.eventReads.readEventsBetween).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("creates a stable revision-scoped wakeup and moves a past reset to the next dispatcher tick", async () => {
    const now = new Date("2026-09-28T12:00:00.000Z");
    const { app, dependencies } = createHarness({
      now: () => now,
      currentTurnEvents: [event(29, "credential_alert", {
        status: "rejected",
        resets_at: "2026-09-28T11:00:00.000Z",
      })],
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-1/resume-after-limit",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      schedule_id: "resume-after-limit:sess-1:32:0",
      run_at: "2026-09-28T12:00:00.000Z",
      status: "active",
      reused: false,
    });
    expect(dependencies.scheduleRepository.createScheduleIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: "resume-after-limit:sess-1:32:0",
        sessionId: "sess-1",
        kind: "wakeup",
        sourceTool: "ResumeAfterLimit",
        toolUseId: "ResumeAfterLimit:32",
        prompt: "리밋 해제 시각이 지났습니다. 이전 지시와 미완료 작업을 이어서 진행해주세요.",
        recurring: false,
        runOnceAt: now,
        nextRunAt: now,
      }),
    );
    await app.close();
  });

  it("reuses an active schedule for the same terminal revision", async () => {
    const active = makeSchedule({
      scheduleId: "resume-after-limit:sess-1:32:0",
      sourceTool: "ResumeAfterLimit",
      toolUseId: "ResumeAfterLimit:32",
      nextRunAt: "2026-09-28T11:00:00.000Z",
    });
    const { app, dependencies } = createHarness({ schedules: [active] });

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-1/resume-after-limit",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      schedule_id: active.scheduleId,
      run_at: active.nextRunAt,
      status: active.status,
      reused: true,
    });
    expect(dependencies.scheduleRepository.createScheduleIfAbsent).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns the documented conflict when no structured reset is available", async () => {
    const { app } = createHarness({ currentTurnEvents: [] });

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-1/resume-after-limit",
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "RATE_LIMIT_RESET_UNAVAILABLE" },
    });
    await app.close();
  });
});

function createHarness(options: {
  now?: () => Date;
  currentTurnEvents?: ReturnType<typeof event>[];
  schedules?: SoulstreamSchedule[];
  accessError?: Error;
} = {}) {
  const app = createApp({ config });
  const currentTurnEvents = options.currentTurnEvents ?? [
    event(25, "credential_alert", {
      status: "rejected",
      resets_at: "2026-09-28T10:00:00Z",
    }),
    event(29, "error", {
      error_code: "claude_rate_limit_stop_failure",
      fatal: true,
      resets_at: "2026-09-28T11:00:00Z",
    }),
  ];
  const schedules = [...(options.schedules ?? [])];
  const sessionReads = {
    getSession: vi.fn(async () => ({
      session_id: "sess-1",
      folder_id: null,
      predecessor_session_id: null,
      status: "error",
      termination_reason: "limit_hit",
      termination_event_id: 32,
    })),
  };
  const eventReads = {
    readRecentEvents: vi.fn(async (_sessionId: string, _limit: number, eventTypes?: string[]) => {
      if (eventTypes?.includes("session_ended")) {
        return [
          event(20, "session_ended", { termination_reason: "error_aborted" }),
          event(32, "session_ended", { termination_reason: "limit_hit" }),
        ];
      }
      return [];
    }),
    readEventsBetween: vi.fn(async () => currentTurnEvents),
  };
  const persistenceRepositoryProvider = vi.fn(async () => ({
    sessionReads,
    eventReads,
  }));
  const scheduleRepository = {
    listSchedulesBySourceToolUseId: vi.fn(async () => schedules),
    createScheduleIfAbsent: vi.fn(async (input: {
      scheduleId: string;
      sessionId: string;
      kind: "wakeup";
      prompt: string;
      sourceTool: string;
      toolUseId: string;
      runOnceAt: Date;
      recurring: false;
      nextRunAt: Date;
    }) => {
      const schedule = makeSchedule({
        scheduleId: input.scheduleId,
        sessionId: input.sessionId,
        kind: input.kind,
        prompt: input.prompt,
        sourceTool: input.sourceTool,
        toolUseId: input.toolUseId,
        runOnceAt: input.runOnceAt.toISOString(),
        nextRunAt: input.nextRunAt.toISOString(),
      });
      schedules.push(schedule);
      return schedule;
    }),
  };
  const scheduleRepositoryProvider = vi.fn(async () => scheduleRepository);
  const accessProvider = {
    requireSessionAccess: vi.fn(async () => {
      if (options.accessError) throw options.accessError;
    }),
  };
  const dependencies = { accessProvider, eventReads, scheduleRepository, sessionReads };

  registerSessionResumeAfterLimitRoutes(app, {
    accessProvider: accessProvider as never,
    persistenceRepositoryProvider: persistenceRepositoryProvider as never,
    scheduleRepositoryProvider: scheduleRepositoryProvider as never,
    now: options.now,
  });

  return { app, dependencies };
}

function event(id: number, event_type: string, payload: Record<string, unknown>) {
  return {
    id,
    session_id: "sess-1",
    event_type,
    payload,
    searchable_text: "",
    created_at: new Date("2026-09-28T09:00:00.000Z"),
  };
}

function makeSchedule(overrides: Partial<SoulstreamSchedule> = {}): SoulstreamSchedule {
  return {
    scheduleId: "schedule-1",
    sessionId: "sess-1",
    kind: "wakeup",
    status: "active",
    prompt: "resume",
    sourceTool: "ResumeAfterLimit",
    toolUseId: "ResumeAfterLimit:32",
    cronExpression: null,
    runOnceAt: "2026-09-28T11:00:00.000Z",
    timezone: "UTC",
    recurring: false,
    nextRunAt: "2026-09-28T11:00:00.000Z",
    lastFiredAt: null,
    firedCount: 0,
    lastError: null,
    claimToken: null,
    claimedUntil: null,
    createdAt: "2026-09-28T09:00:00.000Z",
    updatedAt: "2026-09-28T09:00:00.000Z",
    ...overrides,
  };
}
