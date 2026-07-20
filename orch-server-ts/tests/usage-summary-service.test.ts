import { describe, expect, it, vi } from "vitest";

import {
  UsageSummaryService,
  type UsageSummaryBridge,
  type UsageSummaryRegistry,
} from "../src/index.js";

describe("UsageSummaryService", () => {
  it("fans out to connected nodes in parallel and projects remaining percentages", async () => {
    const pending = new Map<string, (value: unknown) => void>();
    const registry = fakeRegistry(["node-b", "node-a"]);
    const bridge = {
      sendPendingCommand: vi.fn(async ({ node }: { node: { nodeId: string } }) =>
        await new Promise((resolve) => pending.set(node.nodeId, resolve))),
    } as unknown as UsageSummaryBridge;
    const service = new UsageSummaryService({
      registry,
      bridge,
      pollIntervalMs: 300_000,
      now: () => new Date("2026-07-20T10:00:00.000Z"),
    });

    const collection = service.collectOnce();
    await Promise.resolve();
    expect(bridge.sendPendingCommand).toHaveBeenCalledTimes(2);

    pending.get("node-a")?.(successResponse(16));
    pending.get("node-b")?.(successResponse(20));
    await collection;

    expect(service.getSummary()).toMatchObject({
      collectedAt: "2026-07-20T10:00:00.000Z",
      nodes: [
        {
          nodeId: "node-a",
          fetchedAt: "2026-07-20T10:00:00.000Z",
          stale: false,
          staleSince: null,
          providers: {
            claude: {
              weeklyRemainingPercent: 84,
              shortRemainingPercent: 70,
              quotas: [{ model: "fable", remainingPercent: 84 }],
            },
            codex: { weeklyRemainingPercent: 20 },
          },
        },
        { nodeId: "node-b", stale: false },
      ],
    });
    expect(registry.createCommand).toHaveBeenCalledWith(
      "node-a",
      { type: "provider_usage_get" },
      { timeoutMs: 15_000 },
    );
  });

  it("preserves the last success and marks only failed nodes stale", async () => {
    let now = new Date("2026-07-20T10:00:00.000Z");
    let failNodeA = false;
    const registry = fakeRegistry(["node-a", "node-b"]);
    const bridge = {
      sendPendingCommand: vi.fn(async ({ node }: { node: { nodeId: string } }) => {
        if (node.nodeId === "node-a" && failNodeA) throw new Error("timeout");
        return successResponse(node.nodeId === "node-a" ? 16 : 30);
      }),
    } as unknown as UsageSummaryBridge;
    const service = new UsageSummaryService({
      registry,
      bridge,
      pollIntervalMs: 300_000,
      now: () => now,
    });

    await service.collectOnce();
    failNodeA = true;
    now = new Date("2026-07-20T10:05:00.000Z");
    await service.collectOnce();

    expect(service.getSummary().nodes).toMatchObject([
      {
        nodeId: "node-a",
        fetchedAt: "2026-07-20T10:00:00.000Z",
        stale: true,
        staleSince: "2026-07-20T10:05:00.000Z",
        providers: { claude: { weeklyRemainingPercent: 84 } },
      },
      {
        nodeId: "node-b",
        fetchedAt: "2026-07-20T10:05:00.000Z",
        stale: false,
        staleSince: null,
      },
    ]);
  });

  it("represents a first-cycle failure without inventing provider data", async () => {
    const registry = fakeRegistry(["node-a"]);
    const service = new UsageSummaryService({
      registry,
      bridge: {
        sendPendingCommand: vi.fn(async () => { throw new Error("offline"); }),
      } as unknown as UsageSummaryBridge,
      pollIntervalMs: 300_000,
      now: () => new Date("2026-07-20T10:00:00.000Z"),
    });

    expect(service.getSummary()).toMatchObject({ collectedAt: null, nodes: [] });
    await service.collectOnce();
    expect(service.getSummary().nodes).toEqual([
      {
        nodeId: "node-a",
        fetchedAt: null,
        stale: true,
        staleSince: "2026-07-20T10:00:00.000Z",
        providers: { claude: null, codex: null, gemini: null },
      },
    ]);
  });

  it("starts immediately and repeats at the configured interval", async () => {
    vi.useFakeTimers();
    try {
      const registry = fakeRegistry([]);
      const service = new UsageSummaryService({
        registry,
        bridge: { sendPendingCommand: vi.fn() } as unknown as UsageSummaryBridge,
        pollIntervalMs: 300_000,
      });

      service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(registry.listConnectedNodes).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(299_999);
      expect(registry.listConnectedNodes).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(registry.listConnectedNodes).toHaveBeenCalledTimes(2);
      await service.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

function fakeRegistry(nodeIds: readonly string[]): UsageSummaryRegistry {
  const nodes = new Map(nodeIds.map((nodeId) => [nodeId, {
    nodeId,
    connectionId: `connection-${nodeId}`,
    connected: true,
  }]));
  return {
    listConnectedNodes: vi.fn(() => [...nodes.values()]),
    getConnectedNode: vi.fn((nodeId: string) => nodes.get(nodeId)),
    createCommand: vi.fn((nodeId: string, payload: { type: string }, options?: { timeoutMs?: number }) => ({
      fireAndForget: false,
      requestId: `request-${nodeId}`,
      commandType: payload.type,
      message: { ...payload, requestId: `request-${nodeId}` },
      result: Promise.resolve({ type: "provider_usage_result" }),
      createdAtMs: 0,
      expiresAtMs: options?.timeoutMs ?? 0,
      timeoutMs: options?.timeoutMs ?? 0,
    })),
  } as unknown as UsageSummaryRegistry;
}

function successResponse(claudeWeeklyUsedPercent: number) {
  return {
    type: "provider_usage_result",
    success: true,
    data: {
      generatedAt: "2026-07-20T09:59:59.000Z",
      providers: {
        claude: limits(claudeWeeklyUsedPercent, 30, [{
          id: "claude:weekly_scoped:fable",
          label: "fable",
          window: "weekly_scoped",
          model: "fable",
          remainingPercent: 84,
          resetAt: 1_753_100_000,
        }]),
        codex: limits(80, null, []),
        gemini: limits(null, null, []),
      },
    },
  };
}

function limits(
  weeklyUsedPercent: number | null,
  shortUsedPercent: number | null,
  quotas: readonly Record<string, unknown>[],
) {
  return {
    status: "auto",
    weeklyUsedPercent,
    weeklyResetAt: 1_753_100_000,
    shortUsedPercent,
    shortResetAt: 1_753_000_000,
    quotas,
  };
}
