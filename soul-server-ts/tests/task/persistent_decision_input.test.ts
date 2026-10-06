import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionDB } from "../../src/db/session_db.js";
import type { ModelCatalog } from "../../src/model_catalog.js";
import type { Task } from "../../src/task/task_models.js";
import type { ProviderUsageCommandHandler } from "../../src/auth/provider_usage.js";
import {
  rememberProviderUsageObservation,
  resetProviderUsageObservationMemo,
} from "../../src/auth/provider_usage_observation.js";
import { buildPersistentDecisionInput } from "../../src/task/persistent_decision_input.js";

const now = new Date("2026-10-06T00:00:00.000Z");

function makeTask(): Task {
  return {
    agentSessionId: "session-1",
    prompt: "hello",
    status: "running",
    persistent: true,
    modelPreset: "claude-opus",
    persistentGeneration: { number: 3 },
    metadata: [{
      type: "persistent_settings",
      value: {
        default_model: { model_preset: "claude-opus", reasoning_effort: "high" },
        fallback_model: { model_preset: "codex-6.1-sol", reasoning_effort: "high" },
      },
    }],
    createdAt: new Date("2026-10-05T00:00:00.000Z"),
    lastEventId: 500,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

function makeUsage(weeklyUsedPercent: number, shortUsedPercent: number) {
  return {
    status: "auto" as const,
    source: "test",
    observedAt: now.toISOString(),
    weeklyTokens: null,
    monthlyTokens: null,
    sessionTokens: null,
    weeklyUsedPercent,
    weeklyResetAt: now.getTime() / 1_000 + 86_400,
    shortUsedPercent,
    shortWindowMinutes: 300,
    shortResetAt: now.getTime() / 1_000 + 3_600,
    planType: null,
    quotas: [],
  };
}

describe("buildPersistentDecisionInput", () => {
  beforeEach(() => resetProviderUsageObservationMemo());

  it("collects context, generation checkpoints and keepalive count from the recent persisted window", async () => {
    const task = makeTask();
    const events = [
      {
        id: 401,
        session_id: task.agentSessionId,
        event_type: "complete",
        payload: {},
        searchable_text: "",
        created_at: new Date("2026-10-05T23:00:00.000Z"),
      },
      {
        id: 420,
        session_id: task.agentSessionId,
        event_type: "metadata",
        payload: {
          metadata_type: "persistent_generation",
          value: {
            first_call: {
              model_preset: "codex-6.1-sol",
              input_tokens: 28_000,
            },
          },
        },
        searchable_text: "",
        created_at: new Date("2026-10-05T23:10:00.000Z"),
      },
      {
        id: 430,
        session_id: task.agentSessionId,
        event_type: "context_usage",
        payload: { used_tokens: 42_000, estimated: true },
        searchable_text: "",
        created_at: new Date("2026-10-05T23:20:00.000Z"),
      },
      {
        id: 450,
        session_id: task.agentSessionId,
        event_type: "intervention_sent",
        payload: {
          purpose: "cache_keepalive",
          caller_info: { source: "system" },
        },
        searchable_text: "",
        created_at: new Date("2026-10-05T23:30:00.000Z"),
      },
      {
        id: 470,
        session_id: task.agentSessionId,
        event_type: "user_message",
        payload: { caller_info: { source: "browser" } },
        searchable_text: "",
        created_at: new Date("2026-10-05T23:40:00.000Z"),
      },
      {
        id: 480,
        session_id: task.agentSessionId,
        event_type: "intervention_sent",
        payload: {
          purpose: "cache_keepalive",
          caller_info: { source: "system" },
        },
        searchable_text: "",
        created_at: new Date("2026-10-05T23:50:00.000Z"),
      },
      {
        id: 490,
        session_id: task.agentSessionId,
        event_type: "complete",
        payload: {},
        searchable_text: "",
        created_at: new Date("2026-10-05T23:55:00.000Z"),
      },
    ];
    const readEvents = vi.fn().mockResolvedValue(events);
    const modelCatalog = {
      resolve: vi.fn((id: string) => ({
        id,
        backend: id.startsWith("claude") ? "claude" : "codex",
      })),
    } as unknown as Pick<ModelCatalog, "resolve">;
    const providerUsage = {
      fetchUsage: vi.fn(),
    } as unknown as ProviderUsageCommandHandler;
    rememberProviderUsageObservation("claude", makeUsage(35, 20), now.toISOString());
    rememberProviderUsageObservation("codex", makeUsage(45, 15), now.toISOString());

    const input = await buildPersistentDecisionInput(
      { task, trigger: "arrival", now },
      {
        db: { readEvents } as unknown as Pick<SessionDB, "readEvents">,
        modelCatalog,
        providerUsage,
        logger: { warn: vi.fn() },
      },
    );

    expect(readEvents).toHaveBeenCalledWith(task.agentSessionId, 300, 200);
    expect(input).toMatchObject({
      trigger: "arrival",
      context_tokens: 42_000,
      context_estimated: true,
      last_call_ended_at: "2026-10-05T23:55:00.000Z",
      keepalive_count: 1,
      current_preset: "claude-opus",
      default_model: "claude-opus",
      fallback_model: "codex-6.1-sol",
      preset_providers: { "claude-opus": "claude", "codex-6.1-sol": "codex" },
      checkpoint_tokens_by_preset: { "codex-6.1-sol": 28_000 },
      accounts: {
        claude: { short_remaining_percent: 80 },
        codex: { short_remaining_percent: 85 },
      },
    });
    expect(input.accounts.claude?.weekly_headroom).toBeCloseTo(50.7142857);
    expect(input.accounts.codex?.weekly_headroom).toBeCloseTo(40.7142857);
    expect(providerUsage.fetchUsage).not.toHaveBeenCalled();
  });

  it("keeps a prior preset checkpoint from persistent-generation metadata beyond the recent event window", async () => {
    const task = makeTask();
    const oldGenerationMetadata = {
      id: 17,
      session_id: task.agentSessionId,
      event_type: "metadata",
      payload: {
        metadata_type: "persistent_generation",
        value: {
          number: 2,
          first_call: {
            generation: 2,
            model_preset: "codex-6.1-sol",
            input_tokens: 28_000,
          },
        },
      },
      searchable_text: "",
      created_at: new Date("2026-10-05T00:00:00.000Z"),
    };
    const readEvents = vi.fn(async (
      _sessionId: string,
      _afterId: number,
      _limit: number,
      eventTypes?: string[],
    ) => eventTypes ? [oldGenerationMetadata] : []);
    const usage = makeUsage(35, 20);
    rememberProviderUsageObservation("claude", usage);
    rememberProviderUsageObservation("codex", usage);

    const input = await buildPersistentDecisionInput(
      { task, trigger: "arrival", now },
      {
        db: { readEvents } as unknown as Pick<SessionDB, "readEvents">,
        modelCatalog: {
          resolve: (id: string) => ({ id, backend: id.startsWith("claude") ? "claude" : "codex" }),
        } as unknown as Pick<ModelCatalog, "resolve">,
        providerUsage: { fetchUsage: vi.fn() } as unknown as ProviderUsageCommandHandler,
        logger: { warn: vi.fn() },
      },
    );

    expect(input.checkpoint_tokens_by_preset).toEqual({ "codex-6.1-sol": 28_000 });
    expect(readEvents).toHaveBeenCalledWith(task.agentSessionId, 0, task.lastEventId, ["metadata"]);
  });

  it("defaults missing context and checkpoints, and refreshes stale provider observations once", async () => {
    const task = makeTask();
    const readEvents = vi.fn().mockResolvedValue([]);
    const refreshed = makeUsage(30, 10);
    const providerUsage = {
      fetchUsage: vi.fn(async () => {
        rememberProviderUsageObservation("claude", refreshed, now.toISOString());
        rememberProviderUsageObservation("codex", refreshed, now.toISOString());
        return { success: true };
      }),
    } as unknown as ProviderUsageCommandHandler;
    rememberProviderUsageObservation("claude", {
      ...refreshed,
      observedAt: "2026-10-05T23:00:00.000Z",
    }, new Date(now.getTime() - 301_000).toISOString());

    const input = await buildPersistentDecisionInput(
      { task, trigger: "arrival", now },
      {
        db: { readEvents } as unknown as Pick<SessionDB, "readEvents">,
        modelCatalog: {
          resolve: (id: string) => ({ id, backend: id.startsWith("claude") ? "claude" : "codex" }),
        } as unknown as Pick<ModelCatalog, "resolve">,
        providerUsage,
        logger: { warn: vi.fn() },
      },
    );

    expect(input).toMatchObject({
      context_tokens: 0,
      context_estimated: false,
      keepalive_count: 0,
      checkpoint_tokens_by_preset: {},
    });
    expect(providerUsage.fetchUsage).toHaveBeenCalledTimes(1);
    expect(input.accounts.claude?.short_remaining_percent).toBe(90);
    expect(input.accounts.codex?.short_remaining_percent).toBe(90);
  });

  it("keeps the last memoized provider observations when the one refresh fails", async () => {
    const task = makeTask();
    const oldObservation = {
      ...makeUsage(35, 20),
      observedAt: "2026-10-05T00:00:00.000Z",
    };
    rememberProviderUsageObservation("claude", oldObservation, "2026-10-05T00:00:00.000Z");
    rememberProviderUsageObservation("codex", oldObservation, "2026-10-05T00:00:00.000Z");
    const fetchUsage = vi.fn(async () => ({ success: false }));

    const input = await buildPersistentDecisionInput(
      { task, trigger: "arrival", now },
      {
        db: { readEvents: vi.fn(async () => []) } as unknown as Pick<SessionDB, "readEvents">,
        modelCatalog: {
          resolve: (id: string) => ({ id, backend: id.startsWith("claude") ? "claude" : "codex" }),
        } as unknown as Pick<ModelCatalog, "resolve">,
        providerUsage: { fetchUsage } as unknown as ProviderUsageCommandHandler,
        logger: { warn: vi.fn() },
      },
    );

    expect(fetchUsage).toHaveBeenCalledOnce();
    expect(input.accounts.claude).toMatchObject({
      short_remaining_percent: 80,
      observed_at: oldObservation.observedAt,
    });
    expect(input.accounts.codex).toMatchObject({
      short_remaining_percent: 80,
      observed_at: oldObservation.observedAt,
    });
  });

  it("preserves a missing provider source timestamp for the decision stale check", async () => {
    const task = makeTask();
    const usage = { ...makeUsage(35, 20), observedAt: null };
    rememberProviderUsageObservation("claude", usage, now.toISOString());
    rememberProviderUsageObservation("codex", usage, now.toISOString());
    const fetchUsage = vi.fn();

    const input = await buildPersistentDecisionInput(
      { task, trigger: "arrival", now },
      {
        db: { readEvents: vi.fn(async () => []) } as unknown as Pick<SessionDB, "readEvents">,
        modelCatalog: {
          resolve: (id: string) => ({ id, backend: id.startsWith("claude") ? "claude" : "codex" }),
        } as unknown as Pick<ModelCatalog, "resolve">,
        providerUsage: { fetchUsage } as unknown as ProviderUsageCommandHandler,
        logger: { warn: vi.fn() },
      },
    );

    expect(fetchUsage).not.toHaveBeenCalled();
    expect(input.accounts.claude).toMatchObject({
      short_remaining_percent: 80,
      observed_at: null,
    });
    expect(input.accounts.codex?.observed_at).toBeNull();
  });

  it("prefers the task's in-memory context usage to an older persisted context event", async () => {
    const task = makeTask();
    task.claudeContextUsage = { usedTokens: 91_000, maxTokens: 200_000 };
    const event = {
      id: 490,
      session_id: task.agentSessionId,
      event_type: "context_usage",
      payload: { used_tokens: 42_000, estimated: true },
      searchable_text: "",
      created_at: new Date("2026-10-05T23:55:00.000Z"),
    };
    const usage = makeUsage(35, 20);
    rememberProviderUsageObservation("claude", usage);
    rememberProviderUsageObservation("codex", usage);

    const input = await buildPersistentDecisionInput(
      { task, trigger: "arrival", now },
      {
        db: { readEvents: vi.fn(async () => [event]) } as unknown as Pick<SessionDB, "readEvents">,
        modelCatalog: {
          resolve: (id: string) => ({ id, backend: id.startsWith("claude") ? "claude" : "codex" }),
        } as unknown as Pick<ModelCatalog, "resolve">,
        providerUsage: { fetchUsage: vi.fn() } as unknown as ProviderUsageCommandHandler,
        logger: { warn: vi.fn() },
      },
    );

    expect(input.context_tokens).toBe(91_000);
    expect(input.context_estimated).toBe(true);
  });
});
