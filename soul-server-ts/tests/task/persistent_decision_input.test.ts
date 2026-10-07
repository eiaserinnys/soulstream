import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionDB } from "../../src/db/session_db.js";
import type { ModelCatalog } from "../../src/model_catalog.js";
import type { Task } from "../../src/task/task_models.js";
import {
  codexLimitsFromUsageResponse,
  type ProviderUsageCommandHandler,
} from "../../src/auth/provider_usage.js";
import {
  rememberProviderUsageObservation,
  resetProviderUsageObservationMemo,
} from "../../src/auth/provider_usage_observation.js";
import { decidePersistentGeneration } from "../../src/task/persistent_decision.js";
import { buildPersistentDecisionInput } from "../../src/task/persistent_decision_input.js";
import { DEFAULT_CONFIG } from "../../src/task/persistent_decision_config.js";

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

function makeUsage(weeklyUsedPercent: number, shortUsedPercent: number, weeklyWindow = "7d") {
  const weeklyResetAt = now.getTime() / 1_000 + 86_400;
  return {
    status: "auto" as const,
    source: "test",
    observedAt: now.toISOString(),
    weeklyTokens: null,
    monthlyTokens: null,
    sessionTokens: null,
    weeklyUsedPercent,
    weeklyResetAt,
    shortUsedPercent,
    shortWindowMinutes: 300,
    shortResetAt: now.getTime() / 1_000 + 3_600,
    planType: null,
    quotas: [{
      id: "weekly",
      label: "7일",
      window: weeklyWindow,
      unit: null,
      used: null,
      remaining: null,
      limit: null,
      usedPercent: weeklyUsedPercent,
      remainingPercent: 100 - weeklyUsedPercent,
      resetAt: weeklyResetAt,
      model: null,
      source: "test",
    }],
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
    rememberProviderUsageObservation("codex", makeUsage(45, 15, "168h"), now.toISOString());

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
    expect(input.accounts.claude?.weekly_remaining_percent).toBe(65);
    expect(input.accounts.codex?.weekly_remaining_percent).toBe(55);
    expect(providerUsage.fetchUsage).not.toHaveBeenCalled();
  });

  it("forces one usage refresh for limit_hit even when observations are fresh", async () => {
    const task = makeTask();
    const claudeUsage = makeUsage(35, 20);
    const codexUsage = makeUsage(35, 20, "168h");
    rememberProviderUsageObservation("claude", claudeUsage, now.toISOString());
    rememberProviderUsageObservation("codex", codexUsage, now.toISOString());
    const fetchUsage = vi.fn(async () => ({ success: true }));

    const input = await buildPersistentDecisionInput(
      { task, trigger: "limit_hit", now, limitResetAt: "2026-10-06T01:00:00.000Z" },
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
    expect(input.limit_reset_at).toBe("2026-10-06T01:00:00.000Z");
    expect(input.accounts.codex?.weekly_remaining_percent).toBe(65);
  });

  it("switches using weekly quota from normalized Codex usage through input collection", async () => {
    const task = makeTask();
    const codexUsage = codexLimitsFromUsageResponse({
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          used_percent: 20,
          limit_window_seconds: 604_800,
          reset_at: Math.floor(Date.parse("2026-10-10T00:00:00.000Z") / 1_000),
        },
        secondary_window: {
          used_percent: 20,
          limit_window_seconds: 18_000,
          reset_at: Math.floor(Date.parse("2026-10-06T05:00:00.000Z") / 1_000),
        },
      },
    });
    expect(codexUsage.quotas.find((quota) => quota.id === "codex:7d")?.window).toBe("168h");
    rememberProviderUsageObservation("claude", makeUsage(35, 20), now.toISOString());
    const fetchUsage = vi.fn(async () => {
      rememberProviderUsageObservation("codex", codexUsage, now.toISOString());
      return { success: true };
    });

    const input = await buildPersistentDecisionInput(
      { task, trigger: "limit_hit", now, limitResetAt: "2026-10-06T01:00:00.000Z" },
      {
        db: { readEvents: vi.fn(async () => []) } as unknown as Pick<SessionDB, "readEvents">,
        modelCatalog: {
          resolve: (id: string) => ({ id, backend: id.startsWith("claude") ? "claude" : "codex" }),
        } as unknown as Pick<ModelCatalog, "resolve">,
        providerUsage: { fetchUsage } as unknown as ProviderUsageCommandHandler,
        logger: { warn: vi.fn() },
      },
    );
    const decision = decidePersistentGeneration(input);

    expect(fetchUsage).toHaveBeenCalledOnce();
    expect(input.accounts.codex?.weekly_remaining_percent).toBe(80);
    expect(decision).toMatchObject({
      action: "new_generation",
      target_preset: "codex-6.1-sol",
      rule: "limit_hit.switch",
    });
  });

  it("keeps the last provider observations when forced limit_hit refresh fails", async () => {
    const task = makeTask();
    const oldObservation = {
      ...makeUsage(35, 20),
      observedAt: "2026-10-05T00:00:00.000Z",
    };
    const oldCodexObservation = {
      ...makeUsage(35, 20, "168h"),
      observedAt: oldObservation.observedAt,
    };
    rememberProviderUsageObservation("claude", oldObservation, "2026-10-05T00:00:00.000Z");
    rememberProviderUsageObservation("codex", oldCodexObservation, "2026-10-05T00:00:00.000Z");
    const fetchUsage = vi.fn(async () => ({ success: false }));

    const input = await buildPersistentDecisionInput(
      { task, trigger: "limit_hit", now },
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
    expect(input.accounts.codex).toMatchObject({
      short_remaining_percent: 80,
      weekly_remaining_percent: 65,
      observed_at: oldObservation.observedAt,
    });
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
    const claudeUsage = makeUsage(35, 20);
    const codexUsage = makeUsage(35, 20, "168h");
    rememberProviderUsageObservation("claude", claudeUsage);
    rememberProviderUsageObservation("codex", codexUsage);

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

  it("uses the latest non-reset measurement when a newer reset measurement exists", async () => {
    const task = makeTask();
    task.persistentGeneration = {
      number: 3,
      firstCall: {
        generation: 3,
        inputTokens: 4_000,
        cachedInputTokens: 0,
        modelPreset: "claude-opus",
        model: "claude-opus-model",
        measuredAt: now.toISOString(),
        contextReset: true,
      } as never,
    };
    const readEvents = vi.fn(async () => [
      {
        id: 17,
        session_id: task.agentSessionId,
        event_type: "metadata",
        payload: {
          metadata_type: "persistent_generation",
          value: {
            first_call: {
              generation: 2,
              model_preset: "claude-opus",
              input_tokens: 72_000,
              context_reset: false,
            },
          },
        },
        searchable_text: "",
        created_at: new Date("2026-10-05T00:00:00.000Z"),
      },
      {
        id: 18,
        session_id: task.agentSessionId,
        event_type: "metadata",
        payload: {
          metadata_type: "persistent_generation",
          value: {
            first_call: {
              generation: 3,
              model_preset: "claude-opus",
              input_tokens: 4_000,
              context_reset: true,
            },
          },
        },
        searchable_text: "",
        created_at: new Date("2026-10-06T00:00:00.000Z"),
      },
    ]);
    rememberProviderUsageObservation("claude", makeUsage(35, 20), now.toISOString());
    rememberProviderUsageObservation("codex", makeUsage(45, 15, "168h"), now.toISOString());

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

    expect(input.checkpoint_tokens_by_preset).toEqual({ "claude-opus": 72_000 });
  });

  it("uses the preset default when reset measurements are the only samples", async () => {
    const task = makeTask();
    task.persistentGeneration = {
      number: 3,
      firstCall: {
        generation: 3,
        inputTokens: 4_000,
        cachedInputTokens: 0,
        modelPreset: "claude-opus",
        model: "claude-opus-model",
        measuredAt: now.toISOString(),
        contextReset: true,
      } as never,
    };
    const readEvents = vi.fn(async () => [{
      id: 18,
      session_id: task.agentSessionId,
      event_type: "metadata",
      payload: {
        metadata_type: "persistent_generation",
        value: {
          first_call: {
            generation: 3,
            model_preset: "claude-opus",
            input_tokens: 4_000,
            context_reset: true,
          },
        },
      },
      searchable_text: "",
      created_at: now,
    }]);
    rememberProviderUsageObservation("claude", makeUsage(35, 20), now.toISOString());
    rememberProviderUsageObservation("codex", makeUsage(45, 15, "168h"), now.toISOString());

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
    const decision = decidePersistentGeneration(input, {
      ...DEFAULT_CONFIG,
      presets: {
        ...DEFAULT_CONFIG.presets,
        "claude-opus": {
          ...DEFAULT_CONFIG.provider_defaults.claude,
          checkpoint_default_tokens: 90_000,
        },
      },
    });

    expect(input.checkpoint_tokens_by_preset).toEqual({});
    expect(decision.inputs_snapshot).toMatchObject({
      checkpoint_tokens: 90_000,
      checkpoint_source: "default",
    });
  });

  it("defaults missing context and checkpoints, and refreshes stale provider observations once", async () => {
    const task = makeTask();
    const readEvents = vi.fn().mockResolvedValue([]);
    const refreshedClaude = makeUsage(30, 10);
    const refreshedCodex = makeUsage(30, 10, "168h");
    const providerUsage = {
      fetchUsage: vi.fn(async () => {
        rememberProviderUsageObservation("claude", refreshedClaude, now.toISOString());
        rememberProviderUsageObservation("codex", refreshedCodex, now.toISOString());
        return { success: true };
      }),
    } as unknown as ProviderUsageCommandHandler;
    rememberProviderUsageObservation("claude", {
      ...refreshedClaude,
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
    const oldCodexObservation = {
      ...makeUsage(35, 20, "168h"),
      observedAt: oldObservation.observedAt,
    };
    rememberProviderUsageObservation("claude", oldObservation, "2026-10-05T00:00:00.000Z");
    rememberProviderUsageObservation("codex", oldCodexObservation, "2026-10-05T00:00:00.000Z");
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
    const claudeUsage = { ...makeUsage(35, 20), observedAt: null };
    const codexUsage = { ...makeUsage(35, 20, "168h"), observedAt: null };
    rememberProviderUsageObservation("claude", claudeUsage, now.toISOString());
    rememberProviderUsageObservation("codex", codexUsage, now.toISOString());
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
    const claudeUsage = makeUsage(35, 20);
    const codexUsage = makeUsage(35, 20, "168h");
    rememberProviderUsageObservation("claude", claudeUsage);
    rememberProviderUsageObservation("codex", codexUsage);

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
