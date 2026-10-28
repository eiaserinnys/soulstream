import { describe, expect, it, vi } from "vitest";

import {
  UsageSummaryService,
  type UsageSummaryBridge,
  type UsageSummaryRegistry,
} from "../src/usage/usage_summary_service.js";

describe("UsageSummaryService", () => {
  it("preserves source observation rather than collector time and wakes after a committed collection", async () => {
    const response = successResponse(16);
    Object.assign(response.data.providers.claude, { source: "claude-api", sourceKind: "remote", observedAt: "2026-07-20T09:59:00.000Z" });
    Object.assign(response.data.providers.claude.quotas[0]!, { source: "claude-api", purpose: "execution" });
    const onCollected = vi.fn();
    const service = new UsageSummaryService({ registry: fakeRegistry(["node"]), bridge: { sendPendingCommand: vi.fn(async () => response) } as unknown as UsageSummaryBridge, pollIntervalMs: 300_000, sharedAccountGroups: [], now: () => new Date("2026-07-20T10:00:00Z"), onCollected });
    await service.collectOnce();
    const claude = service.getSummary().nodes[0]?.providers.claude;
    expect(claude).toMatchObject({ observedAt: "2026-07-20T09:59:00.000Z", source: "claude-api", sourceKind: "remote", quotas: [{ source: "claude-api", purpose: "execution" }] });
    expect(claude).not.toHaveProperty("mode");
    expect(claude).not.toHaveProperty("accounts");
    expect(claude).not.toHaveProperty("pool");
    expect(claude).not.toHaveProperty("fable_pool");
    expect(onCollected).toHaveBeenCalledOnce();
    expect(onCollected.mock.calls[0]?.[0].collectedAt).toBe("2026-07-20T10:00:00.000Z");
  });

  it("preserves Claude account-pool fields through parser and summary projection", async () => {
    const response = successResponse(16);
    const account = poolAccount("account-a");
    const pool = {
      available_count: 1,
      total_count: 1,
      best_weekly_remaining_percent: 84,
      best_weekly_resets_at: "2026-07-21T10:00:00.000Z",
      earliest_available_at: null,
    };
    Object.assign(response.data.providers.claude, {
      mode: "pool",
      accounts: [account],
      pool,
      fable_pool: { ...pool, best_weekly_remaining_percent: 72 },
    });
    const service = new UsageSummaryService({
      registry: fakeRegistry(["node-a"]),
      bridge: { sendPendingCommand: vi.fn(async () => response) } as unknown as UsageSummaryBridge,
      pollIntervalMs: 300_000,
      sharedAccountGroups: [],
    });

    await service.collectOnce();

    expect(service.getSummary().nodes[0]?.providers.claude).toMatchObject({
      mode: "pool",
      accounts: [account],
      pool,
      fable_pool: { ...pool, best_weekly_remaining_percent: 72 },
    });
  });

  it("collects pool usage per node while retaining legacy shared-provider projection", async () => {
    const registry = fakeRegistry(["pool-node", "legacy-node"]);
    registry.getConnectedNode("pool-node")!.capabilities = { claude_account_pool_v1: true };
    const bridge = {
      sendPendingCommand: vi.fn(async ({ node }: { node: { nodeId: string } }) => {
        const response = successResponse(node.nodeId === "pool-node" ? 10 : 30);
        if (node.nodeId === "pool-node") {
          Object.assign(response.data.providers.claude, {
            mode: "pool",
            accounts: [poolAccount("pool-account")],
            pool: null,
            fable_pool: null,
          });
        }
        return response;
      }),
    } as unknown as UsageSummaryBridge;
    const service = new UsageSummaryService({
      registry,
      bridge,
      pollIntervalMs: 300_000,
      sharedAccountGroups: [{ provider: "claude", nodeIds: ["pool-node", "legacy-node"] }],
    });

    await service.collectOnce();

    expect(registry.createCommand).toHaveBeenCalledTimes(2);
    expect(service.getSummary().nodes).toMatchObject([
      { nodeId: "legacy-node", providers: { claude: { weeklyRemainingPercent: 70 } } },
      { nodeId: "pool-node", providers: { claude: { weeklyRemainingPercent: 90, mode: "pool", accounts: [{ id: "pool-account" }] } } },
    ]);
    expect(service.getSummary().nodes.find((node) => node.nodeId === "legacy-node")?.providers.claude)
      .not.toHaveProperty("accounts");
  });

  it("refreshes only the target Claude provider and publishes the exact GET snapshot", async () => {
    const registry = fakeRegistry(["node-a", "node-b"]);
    let refreshedAccounts = [poolAccount("account-a")];
    const bridge = {
      sendPendingCommand: vi.fn(async ({ node, command }: {
        node: { nodeId: string };
        command: { message: { provider?: string } };
      }) => {
        if (command.message.provider === "claude") {
          const response = providerSuccessResponse("claude", 10);
          Object.assign(response.data, {
            mode: "pool",
            accounts: refreshedAccounts,
            pool: null,
            fable_pool: null,
          });
          return response;
        }
        return successResponse(node.nodeId === "node-a" ? 20 : 40);
      }),
    } as unknown as UsageSummaryBridge;
    const onCollected = vi.fn();
    const service = new UsageSummaryService({
      registry,
      bridge,
      pollIntervalMs: 300_000,
      sharedAccountGroups: [],
      onCollected,
    });
    await service.collectOnce();
    const published: unknown[] = [];
    const unsubscribe = service.subscribe((snapshot) => published.push(snapshot));
    refreshedAccounts = [poolAccount("account-b")];

    const returned = await service.refreshNode("node-a");

    expect(returned).toEqual(service.getSummary());
    expect(returned.nodes.find((node) => node.nodeId === "node-a")?.providers.claude)
      .toMatchObject({ mode: "pool", accounts: [{ id: "account-b" }] });
    expect(returned.nodes.find((node) => node.nodeId === "node-a")?.providers.codex)
      .toMatchObject({ weeklyRemainingPercent: 20 });
    expect(returned.nodes.find((node) => node.nodeId === "node-b")?.providers.claude)
      .toMatchObject({ weeklyRemainingPercent: 60 });
    expect(published).toEqual([returned]);
    expect(onCollected).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("shares durable rejection memory by configured provider account across collections", async () => {
    const service = new UsageSummaryService({
      registry: fakeRegistry(["node-a", "node-b"]),
      bridge: {
        sendPendingCommand: vi.fn(async () => successResponse(16)),
      } as unknown as UsageSummaryBridge,
      pollIntervalMs: 300_000,
      sharedAccountGroups: [{ provider: "codex", nodeIds: ["node-b", "node-a"] }],
      now: () => new Date("2026-07-20T10:00:00.000Z"),
    });

    service.observeProviderExecution({
      nodeId: "node-a",
      eventType: "error",
      payload: {
        type: "error",
        error_code: "codex_usage_limit_exceeded",
        rate_limit_type: "five_hour",
        resets_at: "2026-07-20T11:00:00.000Z",
      },
      createdAt: "2026-07-20T09:59:00.000Z",
    });
    const rejection = service.getLimitRejection("node-b", "codex");
    expect(rejection).toMatchObject({
      rejectedUntil: "2026-07-20T11:00:00.000Z",
      observedAt: "2026-07-20T09:59:00.000Z",
    });

    await service.collectOnce();

    expect(service.getLimitRejection("node-a", "codex")).toEqual(rejection);
    expect(service.getLimitRejection("node-b", "codex")).toEqual(rejection);
  });
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
      sharedAccountGroups: [],
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
      sharedAccountGroups: [],
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
      sharedAccountGroups: [],
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
        providers: { claude: null, codex: null, antigravity: null },
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
        sharedAccountGroups: [],
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

  it("queries shared providers once and copies their limits to connected group members", async () => {
    const registry = fakeRegistry(["node-c", "node-b", "node-a"]);
    const bridge = {
      sendPendingCommand: vi.fn(async ({ node, command }: {
        node: { nodeId: string };
        command: { message: { provider?: string } };
      }) => {
        const provider = command.message.provider;
        if (provider === undefined) return successResponse(10, 20);
        const usedPercentByQuery: Readonly<Record<string, number>> = {
          "node-a:claude": 40,
          "node-b:antigravity": 50,
        };
        const usedPercent = usedPercentByQuery[`${node.nodeId}:${provider}`];
        if (usedPercent === undefined) throw new Error("unexpected provider query");
        return providerSuccessResponse(provider, usedPercent);
      }),
    } as unknown as UsageSummaryBridge;
    const service = new UsageSummaryService({
      registry,
      bridge,
      pollIntervalMs: 300_000,
      sharedAccountGroups: [
        { provider: "claude", nodeIds: ["node-c", "node-b"] },
        { provider: "codex", nodeIds: ["node-c", "node-b", "node-a"] },
        { provider: "antigravity", nodeIds: ["node-c", "node-a"] },
      ],
      now: () => new Date("2026-07-20T10:00:00.000Z"),
    });

    await service.collectOnce();

    expect(registry.createCommand).toHaveBeenCalledTimes(3);
    expect(registry.createCommand).toHaveBeenCalledWith(
      "node-c",
      { type: "provider_usage_get" },
      { timeoutMs: 15_000 },
    );
    expect(registry.createCommand).toHaveBeenCalledWith(
      "node-a",
      { type: "provider_usage_get", provider: "claude" },
      { timeoutMs: 15_000 },
    );
    expect(registry.createCommand).toHaveBeenCalledWith(
      "node-b",
      { type: "provider_usage_get", provider: "antigravity" },
      { timeoutMs: 15_000 },
    );
    expect(service.getSummary().nodes).toMatchObject([
      {
        nodeId: "node-a",
        providers: {
          claude: { weeklyRemainingPercent: 60 },
          codex: { weeklyRemainingPercent: 80 },
          antigravity: { status: "not_configured", weeklyRemainingPercent: null },
        },
      },
      {
        nodeId: "node-b",
        providers: {
          claude: { weeklyRemainingPercent: 90 },
          codex: { weeklyRemainingPercent: 80 },
          antigravity: { weeklyRemainingPercent: 50 },
        },
      },
      {
        nodeId: "node-c",
        providers: {
          claude: { weeklyRemainingPercent: 90 },
          codex: { weeklyRemainingPercent: 80 },
          antigravity: { status: "not_configured", weeklyRemainingPercent: null },
        },
      },
    ]);
  });

  it("uses the first connected member in configured order as the shared representative", async () => {
    const registry = fakeRegistry(["node-a", "node-z"]);
    const bridge = {
      sendPendingCommand: vi.fn(async () => successResponse(10, 20)),
    } as unknown as UsageSummaryBridge;
    const service = new UsageSummaryService({
      registry,
      bridge,
      pollIntervalMs: 300_000,
      sharedAccountGroups: [
        { provider: "claude", nodeIds: ["node-z", "node-a"] },
        { provider: "codex", nodeIds: ["node-z", "node-a"] },
        { provider: "antigravity", nodeIds: ["node-z", "node-a"] },
      ],
      now: () => new Date("2026-07-20T10:00:00.000Z"),
    });

    await service.collectOnce();

    expect(registry.createCommand).toHaveBeenCalledTimes(1);
    expect(registry.createCommand).toHaveBeenCalledWith(
      "node-z",
      { type: "provider_usage_get" },
      { timeoutMs: 15_000 },
    );
  });

  it("keeps every member stale when the shared representative query fails", async () => {
    let now = new Date("2026-07-20T10:00:00.000Z");
    let failRepresentative = false;
    const registry = fakeRegistry(["node-b", "node-a"]);
    const bridge = {
      sendPendingCommand: vi.fn(async ({ node, command }: {
        node: { nodeId: string };
        command: { message: { provider?: string } };
      }) => {
        if (node.nodeId === "node-a" && failRepresentative) throw new Error("timeout");
        const provider = command.message.provider;
        return provider === undefined
          ? successResponse(10, 20)
          : providerSuccessResponse(provider, provider === "claude" ? 40 : 50);
      }),
    } as unknown as UsageSummaryBridge;
    const service = new UsageSummaryService({
      registry,
      bridge,
      pollIntervalMs: 300_000,
      sharedAccountGroups: [
        { provider: "codex", nodeIds: ["node-a", "node-b"] },
      ],
      now: () => now,
    });

    await service.collectOnce();
    failRepresentative = true;
    now = new Date("2026-07-20T10:05:00.000Z");
    await service.collectOnce();

    expect(service.getSummary().nodes).toMatchObject([
      {
        nodeId: "node-a",
        fetchedAt: "2026-07-20T10:00:00.000Z",
        stale: true,
        staleSince: "2026-07-20T10:05:00.000Z",
        providers: { codex: { weeklyRemainingPercent: 80 } },
      },
      {
        nodeId: "node-b",
        fetchedAt: "2026-07-20T10:00:00.000Z",
        stale: true,
        staleSince: "2026-07-20T10:05:00.000Z",
        providers: { codex: { weeklyRemainingPercent: 80 } },
      },
    ]);
    expect(registry.createCommand).not.toHaveBeenCalledWith(
      "node-b",
      expect.objectContaining({ provider: "codex" }),
      expect.anything(),
    );
  });
});

function fakeRegistry(nodeIds: readonly string[]): UsageSummaryRegistry {
  const nodes = new Map(nodeIds.map((nodeId) => [nodeId, {
    nodeId,
    connectionId: `connection-${nodeId}`,
    connected: true,
    supportedBackends: ["claude", "codex", "antigravity"],
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

function successResponse(
  claudeWeeklyUsedPercent: number,
  codexWeeklyUsedPercent = 80,
) {
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
        codex: limits(codexWeeklyUsedPercent, null, []),
        antigravity: { status: "not_configured", weeklyUsedPercent: null, weeklyResetAt: null, shortUsedPercent: null, shortResetAt: null, quotas: [] },
      },
    },
  };
}

function poolAccount(id: string) {
  return {
    id,
    email: `${id}@example.com`,
    plan: null,
    enabled: true,
    priority: null,
    auth_state: "ok",
    usage: { five_hour: null, seven_day: null, fable_weekly: null },
    observed_at: null,
    blocked: null,
    active_sessions: 0,
  } as const;
}

function providerSuccessResponse(provider: string, weeklyUsedPercent: number) {
  return {
    type: "provider_usage_result",
    success: true,
    data: limits(weeklyUsedPercent, null, []),
    provider,
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

it("projects Antigravity and fills only its absence in full snapshots", async () => {
  // Preserve compatibility when a full snapshot omits the added provider.
  const { antigravity: _antigravity, ...legacyProviders } = successResponse(16).data.providers;
  let response: unknown = { ...successResponse(16), data: { providers: legacyProviders } };
  const service = new UsageSummaryService({ registry: fakeRegistry(["node-a"]), bridge: { sendPendingCommand: vi.fn(async () => response) } as unknown as UsageSummaryBridge, pollIntervalMs: 300_000, sharedAccountGroups: [] });
  await service.collectOnce();
  expect(service.getSummary().nodes[0]?.providers.antigravity).toMatchObject({ status: "not_configured", quotas: [] });
  response = { ...successResponse(16), data: { providers: { ...successResponse(16).data.providers, antigravity: limits(10, 20, [{ id: "antigravity:gemini:weekly", label: "7일", window: "7d", model: null, remainingPercent: 90, resetAt: 1_753_100_000 }]) } } };
  await service.collectOnce();
  expect(service.getSummary().nodes[0]?.providers.antigravity).toMatchObject({ status: "auto", weeklyRemainingPercent: 90, shortRemainingPercent: 80, quotas: [{ window: "7d", model: null }] });
  expect(service.getSummary().nodes[0]?.stale).toBe(false);
});

it.each([false, true])("keeps existing usage fresh without requesting an unadvertised Antigravity backend (shared account: %s)", async (shared) => {
  const registry = fakeRegistry(["node-a", "node-b"]);
  registry.getConnectedNode("node-b")!.supportedBackends = ["claude", "codex", "gemini"];
  const onWarning = vi.fn();
  const bridge = {
    sendPendingCommand: vi.fn(async ({ node, command }: {
      node: { nodeId: string };
      command: { message: { provider?: string } };
    }) => {
      const provider = command.message.provider;
      if (node.nodeId === "node-b" && provider === "antigravity") {
        return { success: false, error: "provider must be one of: claude, codex, gemini" };
      }
      return provider === undefined
        ? successResponse(10, 20)
        : providerSuccessResponse(provider, provider === "claude" ? 10 : provider === "codex" ? 20 : 30);
    }),
  } as unknown as UsageSummaryBridge;
  const service = new UsageSummaryService({
    registry, bridge, pollIntervalMs: 300_000,
    sharedAccountGroups: shared ? [{ provider: "codex", nodeIds: ["node-a", "node-b"] }] : [],
    onWarning,
  });

  await service.collectOnce();

  expect(registry.createCommand).not.toHaveBeenCalledWith("node-b", expect.objectContaining({ provider: "antigravity" }), expect.anything());
  expect(service.getSummary().nodes.find((node) => node.nodeId === "node-b")).toMatchObject({
    stale: false, staleSince: null,
    providers: {
      claude: { status: "auto", weeklyRemainingPercent: 90 },
      codex: { status: "auto", weeklyRemainingPercent: 80 },
      antigravity: { status: "not_configured", quotas: [] },
    },
  });
  expect(onWarning).not.toHaveBeenCalled();
});

it("preserves collection errors from an advertised Antigravity backend", async () => {
  const registry = fakeRegistry(["node-a", "node-b"]);
  const bridge = {
    sendPendingCommand: vi.fn(async ({ command }: { command: { message: { provider?: string } } }) => {
      const provider = command.message.provider;
      if (provider === "antigravity") return { success: true, data: { ...limits(null, null, []), status: "error" } };
      return provider === undefined ? successResponse(10, 20) : providerSuccessResponse(provider, 10);
    }),
  } as unknown as UsageSummaryBridge;
  const service = new UsageSummaryService({
    registry, bridge, pollIntervalMs: 300_000,
    sharedAccountGroups: [{ provider: "codex", nodeIds: ["node-a", "node-b"] }],
  });
  await service.collectOnce();
  expect(service.getSummary().nodes.find((node) => node.nodeId === "node-b")?.providers.antigravity).toMatchObject({ status: "error", quotas: [] });
});

it("ignores the legacy Gemini key at the snapshot boundary even when it is malformed", async () => {
  const response = successResponse(16);
  const service = new UsageSummaryService({ registry: fakeRegistry(['node-a']),
    bridge: { sendPendingCommand: vi.fn(async () => ({ ...response, data: { providers: { ...response.data.providers, gemini: 'retired' } } })) } as unknown as UsageSummaryBridge,
    pollIntervalMs: 300_000, sharedAccountGroups: [] });
  await service.collectOnce();
  const node = service.getSummary().nodes[0]!;
  expect(node.stale).toBe(false);
  expect(Object.keys(node.providers)).toEqual(['claude', 'codex', 'antigravity']);
});

it("requests only Claude and Codex from a worker that does not advertise Antigravity", async () => {
  const registry = fakeRegistry(['legacy']);
  registry.getConnectedNode('legacy')!.supportedBackends = ['claude', 'codex'];
  const service = new UsageSummaryService({ registry,
    bridge: { sendPendingCommand: vi.fn(async ({ command }: { command: { message: { provider: string } } }) => providerSuccessResponse(command.message.provider, 20)) } as unknown as UsageSummaryBridge,
    pollIntervalMs: 300_000, sharedAccountGroups: [] });
  await service.collectOnce();
  expect((registry.createCommand as ReturnType<typeof vi.fn>).mock.calls.map(call => call[1].provider)).toEqual(['claude', 'codex']);
});
