import { describe, expect, it, vi } from "vitest";

import {
  SupervisorWakeRouter,
  SupervisorWakeScheduler,
} from "../../src/supervisor/wake_router.js";

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

  it("drains events from any session owned by the same supervisor role", async () => {
    const wake = vi.fn(async () => undefined);
    const setCursor = vi.fn(async () => undefined);
    const getSourceSessionAgentId = vi.fn(async (sourceSessionId: string) =>
      sourceSessionId === "sess-old-supervisor" ? "ariela_codex" : "ordinary-agent"
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
      getSourceSessionAgentId,
    });

    await expect(router.flush("ariela_codex", "sess-current-supervisor")).resolves.toEqual({
      woken: true,
      drained: 3,
    });
    expect(getSourceSessionAgentId).toHaveBeenCalledTimes(2);
    expect(getSourceSessionAgentId).toHaveBeenCalledWith("sess-old-supervisor");
    expect(getSourceSessionAgentId).toHaveBeenCalledWith("sess-other");
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

  it("does not advance snapshot cursor when snapshot delivery fails", async () => {
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
    expect(setCursor).not.toHaveBeenCalled();
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
