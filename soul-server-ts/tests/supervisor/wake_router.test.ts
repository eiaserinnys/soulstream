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
