import { describe, expect, it, vi } from "vitest";

import type {
  ClaudeClient,
  ClaudeRunOptions,
} from "../../src/engine/claude_adapter.js";
import { ClaudeSessionClientRegistry } from "../../src/engine/claude_session_client_registry.js";
import type { ClaudeClientEvent } from "../../src/engine/claude_event_mapper.js";

describe("ClaudeSessionClientRegistry", () => {
  it("reuses one client per session and closes it only on explicit removal", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const createClient = vi.fn(
      (): ClaudeClient => ({
        async *run(
          _options: ClaudeRunOptions,
          _signal: AbortSignal,
        ): AsyncIterable<ClaudeClientEvent> {},
        close,
      }),
    );
    const registry = new ClaudeSessionClientRegistry(
      createClient,
      { idleTtlMs: 300_000, maxEntries: 16 },
    );

    expect(registry.acquire("session-1")).toBe(registry.acquire("session-1"));
    expect(registry.acquire("session-2")).not.toBe(registry.acquire("session-1"));
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(registry.size()).toBe(2);

    await registry.close("session-1");
    expect(close).toHaveBeenCalledTimes(1);
    expect(registry.size()).toBe(1);

    await registry.shutdown();
    expect(close).toHaveBeenCalledTimes(2);
    expect(registry.size()).toBe(0);
  });

  it("reclaims a released idle Query after TTL but retains background work until terminal", async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn().mockResolvedValue(undefined);
      const activity = {
        foregroundPhase: "drain" as const,
        queryLifecycle: "open" as const,
        backgroundTaskCount: 1,
        pendingInputRequestCount: 0,
      };
      const client: ClaudeClient = {
        async *run() {},
        close,
        persistentRuntimeActivity: () => activity,
      };
      const registry = new ClaudeSessionClientRegistry(
        () => client,
        { idleTtlMs: 1_000, maxEntries: 4 },
      );

      registry.acquire("session-bg");
      registry.release("session-bg");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(registry.has("session-bg")).toBe(true);
      expect(close).not.toHaveBeenCalled();

      activity.foregroundPhase = "idle";
      activity.backgroundTaskCount = 0;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(registry.has("session-bg")).toBe(false);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces the registry cap without evicting attached or background sessions", async () => {
    const closes = new Map<string, ReturnType<typeof vi.fn>>();
    const activities = new Map<string, {
      foregroundPhase: "idle";
      queryLifecycle: "open";
      backgroundTaskCount: number;
      pendingInputRequestCount: number;
    }>();
    const registry = new ClaudeSessionClientRegistry(
      (sessionId): ClaudeClient => {
        const close = vi.fn().mockResolvedValue(undefined);
        closes.set(sessionId, close);
        const activity = {
          foregroundPhase: "idle" as const,
          queryLifecycle: "open" as const,
          backgroundTaskCount: 0,
          pendingInputRequestCount: 0,
        };
        activities.set(sessionId, activity);
        return {
          async *run() {},
          close,
          persistentRuntimeActivity: () => activity,
        };
      },
      { idleTtlMs: 60_000, maxEntries: 1 },
    );

    registry.acquire("session-1");
    expect(() => registry.acquire("session-2")).toThrow("capacity");

    registry.release("session-1");
    registry.acquire("session-2");
    await vi.waitFor(() => expect(closes.get("session-1")).toHaveBeenCalledTimes(1));
    expect(registry.has("session-1")).toBe(false);
    expect(registry.has("session-2")).toBe(true);

    registry.release("session-2");
    activities.get("session-2")!.backgroundTaskCount = 1;
    expect(() => registry.acquire("session-3")).toThrow("capacity");
    await registry.shutdown();
  });

  it("keeps background and AskUserQuestion controls reachable after foreground release", async () => {
    const deliverInputResponse = vi.fn().mockReturnValue(true);
    const backgroundClaudeRuntimeTasks = vi.fn().mockResolvedValue({ status: "ok" });
    const stopClaudeRuntimeTask = vi.fn().mockResolvedValue({ status: "ok" });
    const registry = new ClaudeSessionClientRegistry(
      (): ClaudeClient => ({
        async *run() {},
        deliverInputResponse,
        backgroundClaudeRuntimeTasks,
        stopClaudeRuntimeTask,
        persistentRuntimeActivity: () => ({
          foregroundPhase: "idle",
          queryLifecycle: "open",
          backgroundTaskCount: 1,
          pendingInputRequestCount: 1,
        }),
      }),
      { idleTtlMs: 60_000, maxEntries: 4 },
    );

    registry.acquire("session-controls");
    registry.release("session-controls");

    await expect(registry.deliverInputResponse(
      "session-controls",
      "ask-1",
      { answer: "yes" },
    )).resolves.toEqual({ status: "delivered" });
    await expect(registry.backgroundClaudeRuntimeTasks(
      "session-controls",
      "tool-1",
    )).resolves.toEqual({ status: "ok" });
    await expect(registry.stopClaudeRuntimeTask(
      "session-controls",
      "bg-1",
    )).resolves.toEqual({ status: "ok" });

    expect(deliverInputResponse).toHaveBeenCalledWith("ask-1", { answer: "yes" });
    expect(backgroundClaudeRuntimeTasks).toHaveBeenCalledWith("tool-1");
    expect(stopClaudeRuntimeTask).toHaveBeenCalledWith("bg-1");
    await registry.shutdown();
  });
});
