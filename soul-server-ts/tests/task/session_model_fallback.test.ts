import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrchProxyConfig } from "../../src/mcp/runtime.js";
import { chooseSessionModelFallbackTarget } from "../../src/task/session_model_fallback.js";
import type { Task } from "../../src/task/task_models.js";
import { buildModelPresetFallbackMetadataEntry } from "@soulstream/wire-schema/model-preset-fallbacks";

const orch: OrchProxyConfig = {
  baseUrl: "https://orch.example.test",
  headers: { authorization: "Bearer test-token" },
};

const policyEntry = buildModelPresetFallbackMetadataEntry(
  "gemini-4-argon",
  ["claude-opus", "codex-6.1-sol"],
);

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "session-1",
    modelPreset: "gemini-4-argon",
    persistent: false,
    terminationReason: "limit_hit",
    metadata: [policyEntry],
    ...overrides,
  } as unknown as Task;
}

function makeCatalog() {
  return {
    resolve: vi.fn((id: string) => ({
      id,
      supported_efforts: ["high"],
      default_effort: id === "codex-6.1-sol" ? "high" : undefined,
    })),
  } as never;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function availability(id: string, available: boolean, remainingPercent: number | null = null) {
  return {
    id,
    available,
    reason: null,
    reason_label: null,
    resets_at: null,
    weekly_headroom: remainingPercent === null ? null : { remaining_percent: remainingPercent },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chooseSessionModelFallbackTarget", () => {
  it("picks the first usable preset after the current one and keeps its default effort", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      model_presets: [
        availability("gemini-4-argon", false),
        availability("claude-opus", true, 50),
        availability("codex-6.1-sol", true, 80),
      ],
    })));

    await expect(chooseSessionModelFallbackTarget(makeTask(), {
      nodeId: "node-one",
      orch,
      modelCatalog: makeCatalog(),
    })).resolves.toEqual({ modelPreset: "claude-opus" });
  });

  it("uses the preset default effort instead of copying the previous model's effort", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      model_presets: [
        availability("gemini-4-argon", false),
        availability("claude-opus", false),
        availability("codex-6.1-sol", true),
      ],
    })));

    await expect(chooseSessionModelFallbackTarget(
      makeTask({ reasoningEffort: "low" }),
      { nodeId: "node-one", orch, modelCatalog: makeCatalog() },
    )).resolves.toEqual({ modelPreset: "codex-6.1-sol", reasoningEffort: "high" });
  });

  it("uses the recorded limit hint before the termination reason is finalized", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      model_presets: [
        availability("gemini-4-argon", false),
        availability("claude-opus", true),
      ],
    })));

    await expect(chooseSessionModelFallbackTarget(
      makeTask({ terminationReason: undefined, pendingTerminationHint: "limit_hit" }),
      { nodeId: "node-one", orch, modelCatalog: makeCatalog() },
    )).resolves.toEqual({ modelPreset: "claude-opus" });
  });

  it.each([
    ["persistent task", { persistent: true }],
    ["non-limit termination", { terminationReason: "error_aborted" as const }],
    ["non-limit recorded hint", {
      terminationReason: undefined,
      pendingTerminationHint: "error_aborted" as const,
    }],
    ["missing policy", { metadata: [] }],
    ["current preset outside the order", { modelPreset: "kimi-2" }],
    ["last preset in the order", { modelPreset: "codex-6.1-sol" }],
  ])("does not switch for %s", async (_label, overrides) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(chooseSessionModelFallbackTarget(
      makeTask(overrides as Partial<Task>),
      { nodeId: "node-one", orch, modelCatalog: makeCatalog() },
    )).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not switch when the chosen candidate is advertised unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      model_presets: [
        availability("gemini-4-argon", false),
        availability("claude-opus", false),
        availability("codex-6.1-sol", false),
      ],
    })));

    await expect(chooseSessionModelFallbackTarget(makeTask(), {
      nodeId: "node-one",
      orch,
      modelCatalog: makeCatalog(),
    })).resolves.toBeNull();
  });

  it("does not switch when the availability lookup fails", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ error: "down" }, 503),
    ));

    await expect(chooseSessionModelFallbackTarget(makeTask(), {
      nodeId: "node-one",
      orch,
      modelCatalog: makeCatalog(),
    })).resolves.toBeNull();
  });

  it("does not switch when the chosen preset cannot be resolved", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      model_presets: [
        availability("gemini-4-argon", false),
        availability("claude-opus", true),
      ],
    })));
    const catalog = { resolve: vi.fn(() => { throw new Error("unknown preset"); }) } as never;

    await expect(chooseSessionModelFallbackTarget(makeTask(), {
      nodeId: "node-one",
      orch,
      modelCatalog: catalog,
      logger: { warn: vi.fn() },
    })).resolves.toBeNull();
  });
});
