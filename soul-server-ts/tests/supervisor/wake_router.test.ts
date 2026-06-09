import { describe, expect, it, vi } from "vitest";

import {
  SupervisorWakeRouter,
  SupervisorWakeScheduler,
} from "../../src/supervisor/wake_router.js";

function allowedSourceContext() {
  return vi.fn(async () => ({
    agentId: "ordinary-agent",
    callerSource: "slack",
  }));
}

describe("SupervisorWakeRouter", () => {
  it("does not schedule quiet progress deltas", async () => {
    const router = new SupervisorWakeRouter({
      getCursor: vi.fn(),
      readEventsAfter: vi.fn(),
      setCursor: vi.fn(),
      wake: vi.fn(),
    });

    await expect(router.ingest("ariela_codex", "progress")).resolves.toEqual({
      scheduled: false,
    });
  });

  it("skips unknown ingests and warns once per event type", async () => {
    const warn = vi.fn();
    const router = new SupervisorWakeRouter({
      getCursor: vi.fn(),
      readEventsAfter: vi.fn(),
      setCursor: vi.fn(),
      wake: vi.fn(),
      logger: { warn },
    });

    await expect(router.ingest("ariela_codex", "metadata")).resolves.toEqual({
      scheduled: false,
    });
    await expect(router.ingest("ariela_codex", "metadata")).resolves.toEqual({
      scheduled: false,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { supervisorId: "ariela_codex", eventType: "metadata" },
      "Supervisor wake router skipped unmapped SSE event type",
    );
  });

  it("drains cursor to head and wakes once for a burst", async () => {
    const wake = vi.fn(async () => undefined);
    const setCursor = vi.fn(async () => undefined);
    const router = new SupervisorWakeRouter({
      getCursor: vi.fn(async () => 10),
      readEventsAfter: vi.fn(async () => [
        { offset: 11, sourceSessionId: "sess-other", eventType: "assistant_message" },
        { offset: 12, sourceSessionId: "sess-other", eventType: "user_message" },
        { offset: 13, sourceSessionId: "sess-other", eventType: "tool_result" },
      ]),
      setCursor,
      wake,
      getSourceSessionWakeContext: allowedSourceContext(),
    });

    await expect(router.flush("ariela_codex")).resolves.toEqual({
      woken: true,
      drained: 3,
    });
    expect(setCursor).toHaveBeenCalledWith("ariela_codex", 13);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith({
      supervisorId: "ariela_codex",
      wakeClass: "wake",
      events: [
        { offset: 11, sourceSessionId: "sess-other", eventType: "assistant_message" },
        { offset: 12, sourceSessionId: "sess-other", eventType: "user_message" },
        { offset: 13, sourceSessionId: "sess-other", eventType: "tool_result" },
      ],
    });
  });

  it("skips unknown flush events and keeps waking for mapped events", async () => {
    const wake = vi.fn(async () => undefined);
    const setCursor = vi.fn(async () => undefined);
    const warn = vi.fn();
    const router = new SupervisorWakeRouter({
      getCursor: vi.fn(async () => 40),
      readEventsAfter: vi.fn(async () => [
        { offset: 41, sourceSessionId: "sess-other", eventType: "metadata" },
        { offset: 42, sourceSessionId: "sess-other", eventType: "assistant_message" },
        { offset: 43, sourceSessionId: "sess-other", eventType: "user_message" },
      ]),
      setCursor,
      wake,
      getSourceSessionWakeContext: allowedSourceContext(),
      logger: { warn },
    });

    await expect(router.flush("ariela_codex")).resolves.toEqual({
      woken: true,
      drained: 3,
    });
    expect(setCursor).toHaveBeenCalledWith("ariela_codex", 43);
    expect(wake).toHaveBeenCalledWith({
      supervisorId: "ariela_codex",
      wakeClass: "wake",
      events: [
        { offset: 42, sourceSessionId: "sess-other", eventType: "assistant_message" },
        { offset: 43, sourceSessionId: "sess-other", eventType: "user_message" },
      ],
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("drains all-unknown flush events without waking", async () => {
    const wake = vi.fn(async () => undefined);
    const setCursor = vi.fn(async () => undefined);
    const warn = vi.fn();
    const router = new SupervisorWakeRouter({
      getCursor: vi.fn(async () => 50),
      readEventsAfter: vi.fn(async () => [
        { offset: 51, sourceSessionId: "sess-other", eventType: "metadata" },
        { offset: 52, sourceSessionId: "sess-other", eventType: "metadata" },
      ]),
      setCursor,
      wake,
      logger: { warn },
    });

    await expect(router.flush("ariela_codex")).resolves.toEqual({
      woken: false,
      drained: 2,
    });
    expect(setCursor).toHaveBeenCalledWith("ariela_codex", 52);
    expect(wake).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("drains self-generated supervisor events without waking itself", async () => {
    const wake = vi.fn(async () => undefined);
    const setCursor = vi.fn(async () => undefined);
    const router = new SupervisorWakeRouter({
      getCursor: vi.fn(async () => 20),
      readEventsAfter: vi.fn(async () => [
        { offset: 21, sourceSessionId: "sess-supervisor", eventType: "assistant_message" },
        { offset: 22, sourceSessionId: "sess-supervisor", eventType: "complete" },
      ]),
      setCursor,
      wake,
    });

    await expect(router.flush("ariela_codex", "sess-supervisor")).resolves.toEqual({
      woken: false,
      drained: 2,
    });
    expect(setCursor).toHaveBeenCalledWith("ariela_codex", 22);
    expect(wake).not.toHaveBeenCalled();
  });

  it("drains non-critical automatic source events without waking", async () => {
    const wake = vi.fn(async () => undefined);
    const setCursor = vi.fn(async () => undefined);
    const router = new SupervisorWakeRouter({
      getCursor: vi.fn(async () => 80),
      readEventsAfter: vi.fn(async () => [
        { offset: 81, sourceSessionId: "sess-llm", eventType: "assistant_message" },
      ]),
      setCursor,
      wake,
      getSourceSessionWakeContext: vi.fn(async () => ({
        agentId: "ordinary-agent",
        callerSource: "llm",
      })),
    });

    await expect(router.flush("ariela_codex", "sess-supervisor")).resolves.toEqual({
      woken: false,
      drained: 1,
    });
    expect(setCursor).toHaveBeenCalledWith("ariela_codex", 81);
    expect(wake).not.toHaveBeenCalled();
  });

  it("wakes for critical automatic source events", async () => {
    const wake = vi.fn(async () => undefined);
    const setCursor = vi.fn(async () => undefined);
    const router = new SupervisorWakeRouter({
      getCursor: vi.fn(async () => 90),
      readEventsAfter: vi.fn(async () => [
        { offset: 91, sourceSessionId: "sess-llm", eventType: "assistant_error" },
      ]),
      setCursor,
      wake,
      getSourceSessionWakeContext: vi.fn(async () => ({
        agentId: "ordinary-agent",
        callerSource: "llm",
      })),
    });

    await expect(router.flush("ariela_codex", "sess-supervisor")).resolves.toEqual({
      woken: true,
      drained: 1,
    });
    expect(wake).toHaveBeenCalledWith({
      supervisorId: "ariela_codex",
      wakeClass: "critical",
      events: [
        { offset: 91, sourceSessionId: "sess-llm", eventType: "assistant_error" },
      ],
    });
  });

  it("keeps missing-source events silent unless they are critical", async () => {
    const wake = vi.fn(async () => undefined);
    const setCursor = vi.fn(async () => undefined);
    const router = new SupervisorWakeRouter({
      getCursor: vi.fn(async () => 100),
      readEventsAfter: vi.fn(async () => [
        { offset: 101, eventType: "complete" },
        { offset: 102, eventType: "error" },
      ]),
      setCursor,
      wake,
    });

    await expect(router.flush("ariela_codex", "sess-supervisor")).resolves.toEqual({
      woken: true,
      drained: 2,
    });
    expect(wake).toHaveBeenCalledWith({
      supervisorId: "ariela_codex",
      wakeClass: "critical",
      events: [
        { offset: 102, eventType: "error" },
      ],
    });
  });

  it("drains events from any session owned by the same supervisor role", async () => {
    const wake = vi.fn(async () => undefined);
    const setCursor = vi.fn(async () => undefined);
    const getSourceSessionWakeContext = vi.fn(async (sourceSessionId: string) =>
      sourceSessionId === "sess-old-supervisor"
        ? { agentId: "ariela_codex", callerSource: "agent" }
        : { agentId: "ordinary-agent", callerSource: "agent" }
    );
    const router = new SupervisorWakeRouter({
      getCursor: vi.fn(async () => 60),
      readEventsAfter: vi.fn(async () => [
        { offset: 61, sourceSessionId: "sess-old-supervisor", eventType: "assistant_message" },
        { offset: 62, sourceSessionId: "sess-old-supervisor", eventType: "complete" },
        { offset: 63, sourceSessionId: "sess-other", eventType: "user_message" },
      ]),
      setCursor,
      wake,
      getSourceSessionWakeContext,
    });

    await expect(router.flush("ariela_codex", "sess-current-supervisor")).resolves.toEqual({
      woken: true,
      drained: 3,
    });
    expect(getSourceSessionWakeContext).toHaveBeenCalledTimes(2);
    expect(getSourceSessionWakeContext).toHaveBeenCalledWith("sess-old-supervisor");
    expect(getSourceSessionWakeContext).toHaveBeenCalledWith("sess-other");
    expect(setCursor).toHaveBeenCalledWith("ariela_codex", 63);
    expect(wake).toHaveBeenCalledWith({
      supervisorId: "ariela_codex",
      wakeClass: "wake",
      events: [
        { offset: 63, sourceSessionId: "sess-other", eventType: "user_message" },
      ],
    });
  });

  it("does not advance the cursor or wake when source session owner lookup fails", async () => {
    const wake = vi.fn(async () => undefined);
    const setCursor = vi.fn(async () => undefined);
    const warn = vi.fn();
    const router = new SupervisorWakeRouter({
      getCursor: vi.fn(async () => 70),
      readEventsAfter: vi.fn(async () => [
        { offset: 71, sourceSessionId: "sess-unknown", eventType: "user_message" },
      ]),
      setCursor,
      wake,
      getSourceSessionAgentId: vi.fn(async () => {
        throw new Error("db down");
      }),
      logger: { warn },
    });

    await expect(router.flush("ariela_codex", "sess-current-supervisor")).rejects.toThrow(
      "Supervisor wake router source session lookup failed",
    );
    expect(setCursor).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      {
        err: expect.any(Error),
        supervisorId: "ariela_codex",
        sourceSessionId: "sess-unknown",
      },
      "Supervisor wake router source session lookup failed",
    );
  });

  it("does not advance the cursor when wake delivery fails", async () => {
    const wake = vi.fn(async () => {
      throw new Error("wake failed");
    });
    const setCursor = vi.fn(async () => undefined);
    const router = new SupervisorWakeRouter({
      getCursor: vi.fn(async () => 30),
      readEventsAfter: vi.fn(async () => [
        { offset: 31, sourceSessionId: "sess-other", eventType: "user_message" },
      ]),
      setCursor,
      wake,
      getSourceSessionWakeContext: allowedSourceContext(),
    });

    await expect(router.flush("ariela_codex", "sess-supervisor")).rejects.toThrow(
      "wake failed",
    );
    expect(setCursor).not.toHaveBeenCalled();
  });

  it("cold-start snapshot drains backlog to head without per-event wake replay", async () => {
    const wake = vi.fn(async () => undefined);
    const wakeSnapshot = vi.fn(async () => undefined);
    const setCursor = vi.fn(async () => undefined);
    const readEventsAfter = vi.fn(async () => [
      { offset: 11, sourceSessionId: "sess-other", eventType: "assistant_message" },
    ]);
    const router = new SupervisorWakeRouter({
      getCursor: vi.fn(async () => 10),
      getHeadOffset: vi.fn(async () => 110),
      readEventsAfter,
      setCursor,
      wake,
      wakeSnapshot,
    });

    await expect(
      router.flush("ariela_codex", "sess-supervisor", { snapshot: true }),
    ).resolves.toEqual({ woken: true, drained: 100 });

    expect(readEventsAfter).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    expect(wakeSnapshot).toHaveBeenCalledWith({
      supervisorId: "ariela_codex",
      headOffset: 110,
    });
    expect(setCursor).toHaveBeenCalledWith("ariela_codex", 110);
  });

  it("advances snapshot cursor even when snapshot delivery fails", async () => {
    const setCursor = vi.fn(async () => undefined);
    const router = new SupervisorWakeRouter({
      getCursor: vi.fn(async () => 10),
      getHeadOffset: vi.fn(async () => 110),
      readEventsAfter: vi.fn(),
      setCursor,
      wake: vi.fn(),
      wakeSnapshot: vi.fn(async () => {
        throw new Error("snapshot failed");
      }),
    });

    await expect(
      router.flush("ariela_codex", "sess-supervisor", { snapshot: true }),
    ).rejects.toThrow("snapshot failed");
    expect(setCursor).toHaveBeenCalledWith("ariela_codex", 110);
  });

  it("blocks the first repeated no-progress wake dispatch before re-sending", async () => {
    const wake = vi.fn(async () => {
      throw new Error("wake failed");
    });
    const error = vi.fn();
    let wakeDispatchState = {
      state: "active" as const,
      lastSignature: null as string | null,
      repeatCount: 0,
    };
    const readEventsAfter = vi.fn(async () => [
      { offset: 31, sourceSessionId: "sess-other", eventType: "user_message" },
    ]);
    const setWakeDispatchState = vi.fn(async (next) => {
      wakeDispatchState = {
        state: next.state,
        lastSignature: next.lastSignature ?? null,
        repeatCount: next.repeatCount,
      };
    });
    const router = new SupervisorWakeRouter({
      getCursor: vi.fn(async () => 30),
      readEventsAfter,
      setCursor: vi.fn(async () => undefined),
      wake,
      getSourceSessionWakeContext: allowedSourceContext(),
      getWakeDispatchState: vi.fn(async () => wakeDispatchState),
      setWakeDispatchState,
      logger: { warn: vi.fn(), error },
    });

    await expect(router.flush("ariela_codex", "sess-supervisor")).rejects.toThrow(
      "wake failed",
    );
    expect(wakeDispatchState).toMatchObject({
      state: "active",
      repeatCount: 0,
    });
    expect(error).not.toHaveBeenCalled();

    await expect(router.flush("ariela_codex", "sess-supervisor")).resolves.toEqual({
      woken: false,
      drained: 0,
      blocked: true,
    });
    expect(wakeDispatchState).toMatchObject({
      state: "blocked",
      repeatCount: 1,
    });
    expect(error).toHaveBeenCalledTimes(1);

    await expect(router.flush("ariela_codex", "sess-supervisor")).resolves.toEqual({
      woken: false,
      drained: 0,
      blocked: true,
    });
    expect(readEventsAfter).toHaveBeenCalledTimes(2);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("does not block repeated normal flushes when the cursor advances", async () => {
    let cursor = 30;
    let wakeDispatchState = {
      state: "active" as const,
      lastSignature: null as string | null,
      repeatCount: 0,
    };
    const wake = vi.fn(async () => undefined);
    const setCursor = vi.fn(async (_supervisorId: string, nextCursor: number) => {
      cursor = nextCursor;
    });
    const router = new SupervisorWakeRouter({
      getCursor: vi.fn(async () => cursor),
      readEventsAfter: vi.fn(async (afterOffset: number) =>
        afterOffset === 30
          ? [{ offset: 31, sourceSessionId: "sess-other", eventType: "user_message" }]
          : [{ offset: 32, sourceSessionId: "sess-other", eventType: "user_message" }]
      ),
      setCursor,
      wake,
      getSourceSessionWakeContext: allowedSourceContext(),
      getWakeDispatchState: vi.fn(async () => wakeDispatchState),
      setWakeDispatchState: vi.fn(async (next) => {
        wakeDispatchState = {
          state: next.state,
          lastSignature: next.lastSignature ?? null,
          repeatCount: next.repeatCount,
        };
      }),
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    await expect(router.flush("ariela_codex", "sess-supervisor")).resolves.toEqual({
      woken: true,
      drained: 1,
    });
    await expect(router.flush("ariela_codex", "sess-supervisor")).resolves.toEqual({
      woken: true,
      drained: 1,
    });

    expect(setCursor).toHaveBeenNthCalledWith(1, "ariela_codex", 31);
    expect(setCursor).toHaveBeenNthCalledWith(2, "ariela_codex", 32);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(wakeDispatchState).toMatchObject({
      state: "active",
      repeatCount: 0,
    });
  });

  it("re-blocks immediately when a retry release makes no forward progress", async () => {
    let wakeDispatchState = {
      state: "retrying" as const,
      lastSignature: null as string | null,
      repeatCount: 0,
    };
    const error = vi.fn();
    const router = new SupervisorWakeRouter({
      getCursor: vi.fn(async () => 30),
      readEventsAfter: vi.fn(async () => [
        { offset: 31, sourceSessionId: "sess-other", eventType: "user_message" },
      ]),
      setCursor: vi.fn(async () => undefined),
      wake: vi.fn(async () => {
        throw new Error("wake failed");
      }),
      getSourceSessionWakeContext: allowedSourceContext(),
      getWakeDispatchState: vi.fn(async () => wakeDispatchState),
      setWakeDispatchState: vi.fn(async (next) => {
        wakeDispatchState = {
          state: next.state,
          lastSignature: next.lastSignature ?? null,
          repeatCount: next.repeatCount,
        };
      }),
      logger: { warn: vi.fn(), error },
    }, { noProgressThreshold: 3 });

    await expect(router.flush("ariela_codex", "sess-supervisor")).rejects.toThrow(
      "wake failed",
    );
    expect(wakeDispatchState).toMatchObject({
      state: "blocked",
      repeatCount: 1,
    });
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("keeps persisted blocked state across cold-start unless manually released", async () => {
    const wake = vi.fn(async () => undefined);
    const wakeSnapshot = vi.fn(async () => undefined);
    const readEventsAfter = vi.fn(async () => [
      { offset: 31, sourceSessionId: "sess-other", eventType: "user_message" },
    ]);
    const setCursor = vi.fn(async () => undefined);
    const router = new SupervisorWakeRouter({
      getCursor: vi.fn(async () => 30),
      getHeadOffset: vi.fn(async () => 110),
      readEventsAfter,
      setCursor,
      wake,
      wakeSnapshot,
      getWakeDispatchState: vi.fn(async () => ({
        state: "blocked",
        lastSignature: "events|30->31|count=1|sources=sess-other|types=user_message",
        repeatCount: 3,
      })),
      setWakeDispatchState: vi.fn(async () => undefined),
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    const scheduler = new SupervisorWakeScheduler({
      listSupervisors: vi.fn(async () => [
        {
          role: "ariela_codex",
          activeSessionId: "sess-supervisor",
          wakeDispatchState: "blocked",
        },
      ]),
      router,
      logger: { warn: vi.fn() },
    });

    scheduler.markSnapshotPending("ariela_codex");
    await scheduler.flush("ariela_codex");

    expect(wakeSnapshot).not.toHaveBeenCalled();
    expect(readEventsAfter).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    expect(setCursor).not.toHaveBeenCalled();
  });

  it("keeps snapshot pending when snapshot flush returns blocked", async () => {
    const router = {
      ingest: vi.fn(async () => ({ scheduled: true })),
      flush: vi.fn(async () => ({ woken: false, drained: 0, blocked: true })),
    };
    const scheduler = new SupervisorWakeScheduler({
      listSupervisors: vi.fn(async () => [
        { role: "ariela_codex", activeSessionId: "sess-supervisor" },
      ]),
      router,
      logger: { warn: vi.fn() },
    });

    scheduler.markSnapshotPending("ariela_codex");
    await scheduler.flush("ariela_codex");
    await scheduler.flush("ariela_codex");

    expect(router.flush).toHaveBeenNthCalledWith(
      1,
      "ariela_codex",
      "sess-supervisor",
      { snapshot: true },
    );
    expect(router.flush).toHaveBeenNthCalledWith(
      2,
      "ariela_codex",
      "sess-supervisor",
      { snapshot: true },
    );
  });

  it("keeps snapshot pending after cursor-advance failure and blocks repeated snapshot without incremental replay", async () => {
    let wakeDispatchState = {
      state: "active" as const,
      lastSignature: null as string | null,
      repeatCount: 0,
    };
    const wake = vi.fn(async () => undefined);
    const wakeSnapshot = vi.fn(async () => undefined);
    const readEventsAfter = vi.fn(async () => [
      { offset: 31, sourceSessionId: "sess-other", eventType: "user_message" },
    ]);
    const router = new SupervisorWakeRouter({
      getCursor: vi.fn(async () => 30),
      getHeadOffset: vi.fn(async () => 110),
      readEventsAfter,
      setCursor: vi.fn(async () => {
        throw new Error("cursor failed");
      }),
      wake,
      wakeSnapshot,
      getWakeDispatchState: vi.fn(async () => wakeDispatchState),
      setWakeDispatchState: vi.fn(async (next) => {
        wakeDispatchState = {
          state: next.state,
          lastSignature: next.lastSignature ?? null,
          repeatCount: next.repeatCount,
        };
      }),
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    const scheduler = new SupervisorWakeScheduler({
      listSupervisors: vi.fn(async () => [
        { role: "ariela_codex", activeSessionId: "sess-supervisor" },
      ]),
      router,
      logger: { warn: vi.fn() },
    });

    scheduler.markSnapshotPending("ariela_codex");
    await expect(scheduler.flush("ariela_codex")).rejects.toThrow("cursor failed");
    await expect(scheduler.flush("ariela_codex")).resolves.toBeUndefined();

    expect(wakeSnapshot).toHaveBeenCalledTimes(1);
    expect(readEventsAfter).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    expect(wakeDispatchState).toMatchObject({
      state: "blocked",
      repeatCount: 1,
    });
  });

  it("uses snapshot once for pending cold start and then resumes incremental flush", async () => {
    const router = {
      ingest: vi.fn(async () => ({ scheduled: true })),
      flush: vi.fn(async () => ({ woken: true, drained: 1 })),
    };
    const scheduler = new SupervisorWakeScheduler({
      listSupervisors: vi.fn(async () => [
        { role: "ariela_codex", activeSessionId: "sess-supervisor" },
      ]),
      router,
      logger: { warn: vi.fn() },
    });

    scheduler.markSnapshotPending("ariela_codex");
    await scheduler.flush("ariela_codex");
    await scheduler.flush("ariela_codex");

    expect(router.flush).toHaveBeenNthCalledWith(
      1,
      "ariela_codex",
      "sess-supervisor",
      { snapshot: true },
    );
    expect(router.flush).toHaveBeenNthCalledWith(
      2,
      "ariela_codex",
      "sess-supervisor",
    );
  });

  it("debounces multiple wake-class ingests into one flush", async () => {
    vi.useFakeTimers();
    const router = {
      ingest: vi.fn(async () => ({ scheduled: true })),
      flush: vi.fn(async () => ({ woken: true, drained: 2 })),
    };
    const scheduler = new SupervisorWakeScheduler({
      listSupervisors: vi.fn(async () => [
        { role: "ariela_codex", activeSessionId: "sess-supervisor" },
      ]),
      router,
      logger: { warn: vi.fn() },
    }, { debounceMs: 50 });

    await scheduler.ingest("user_message");
    await scheduler.ingest("assistant_message");
    await vi.advanceTimersByTimeAsync(50);

    expect(router.ingest).toHaveBeenCalledTimes(2);
    expect(router.flush).toHaveBeenCalledTimes(1);
    expect(router.flush).toHaveBeenCalledWith("ariela_codex", "sess-supervisor");
    scheduler.dispose();
    vi.useRealTimers();
  });
});
