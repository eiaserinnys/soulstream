import { describe, expect, it, vi } from "vitest";

import {
  AgentRegistry,
  type AgentProfile,
} from "../../src/agent_registry.js";
import {
  UnknownModelPresetError,
  type ModelPreset,
} from "../../src/model_catalog.js";
import {
  applyModelPresetRuntime,
  effectiveTaskBackend,
  resolveEffectiveTurnPreset,
  resolveModelPresetSelection,
  resolveOpenCodeMcpToolAllowlist,
} from "../../src/task/task_model_preset.js";
import type { Task } from "../../src/task/task_models.js";

const agent: AgentProfile = {
  id: "roselin",
  name: "로젤린",
  backend: "codex",
  workspace_dir: "/tmp/roselin",
  default_preset: "codex-sol",
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-model-preset",
    prompt: "hi",
    status: "running",
    createdAt: new Date(),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

const kimiPreset: ModelPreset = {
  id: "kimi-2",
  label: "Kimi - 2",
  backend: "claude",
  model: "kimi-for-coding",
  env: {
    ANTHROPIC_API_KEY: "${KIMI_API_KEY}",
    ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
  },
};

describe("task model preset runtime", () => {
  it("resolves the current agent allowlist only for an OpenCode backend", () => {
    const allowlist = { soulstream: ["get_session_name"], serendipity: [] };
    const resolve = vi.fn().mockReturnValue({
      id: "opencode-test",
      label: "OpenCode Test",
      backend: "opencode",
      model: "opencode/test",
      mcp_tool_allowlist: { roselin: allowlist, other: { soulstream: ["list_sessions"] } },
    } satisfies ModelPreset);
    const catalog = { resolve };
    const task = makeTask({ modelPreset: "opencode-test", modelPresetBackend: "opencode" });

    expect(resolveOpenCodeMcpToolAllowlist(task, agent, catalog)).toEqual(allowlist);
    expect(resolve).toHaveBeenCalledWith("opencode-test");
    expect(task).not.toHaveProperty("mcp_tool_allowlist");
    expect(resolveOpenCodeMcpToolAllowlist(task, { ...agent, id: "other" }, catalog)).toEqual({
      soulstream: ["list_sessions"],
    });
  });

  it.each(["claude", "codex"] as const)(
    "does not resolve or forward the allowlist for the %s backend",
    (backend) => {
      const resolve = vi.fn();
      const task = makeTask({ modelPreset: "opencode-test", modelPresetBackend: backend });

      expect(resolveOpenCodeMcpToolAllowlist(task, agent, { resolve })).toBeUndefined();
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it("returns no allowlist when the selected profile has no entry", () => {
    const resolve = vi.fn().mockReturnValue({
      id: "opencode-test",
      label: "OpenCode Test",
      backend: "opencode",
      model: "opencode/test",
      mcp_tool_allowlist: { other: { soulstream: ["list_sessions"] } },
    } satisfies ModelPreset);
    const task = makeTask({ modelPreset: "opencode-test", modelPresetBackend: "opencode" });

    expect(resolveOpenCodeMcpToolAllowlist(task, agent, { resolve })).toBeUndefined();
  });

  it("restores backend and env from a persisted preset while preserving the persisted model", () => {
    const task = makeTask({
      modelPreset: "kimi-2",
      model: "persisted-kimi-model",
    });
    const resolve = vi.fn().mockReturnValue(kimiPreset);

    applyModelPresetRuntime(task, agent, { resolve });

    expect(resolve).toHaveBeenCalledWith("kimi-2");
    expect(task).toMatchObject({
      modelPreset: "kimi-2",
      model: "persisted-kimi-model",
      modelPresetBackend: "claude",
      modelPresetEnv: kimiPreset.env,
    });
    expect(effectiveTaskBackend(task, agent)).toBe("claude");
  });

  it("resolves the agent default only when no legacy task model was specified", () => {
    const defaultPreset: ModelPreset = {
      id: "codex-sol",
      label: "Codex - 5.6 Sol",
      backend: "codex",
      model: "gpt-5.6-sol",
    };
    const resolve = vi.fn().mockReturnValue(defaultPreset);
    const defaultTask = makeTask();
    const legacyTask = makeTask({ model: "legacy-model" });

    applyModelPresetRuntime(defaultTask, agent, { resolve });
    applyModelPresetRuntime(legacyTask, agent, { resolve });

    expect(defaultTask).toMatchObject({
      modelPreset: "codex-sol",
      model: "gpt-5.6-sol",
      modelPresetBackend: "codex",
    });
    expect(legacyTask.modelPreset).toBeUndefined();
    expect(effectiveTaskBackend(legacyTask, agent)).toBe("codex");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("restores an alias-specific preset for a legacy session without model_preset", () => {
    const aliasAgent = new AgentRegistry([{
      ...agent,
      aliases: [{ id: "roselin-opus", default_preset: "claude-opus" }],
    }]).get("roselin-opus");
    expect(aliasAgent).toBeDefined();
    const task = makeTask({ profileId: "roselin-opus", modelPreset: null });
    const resolve = vi.fn().mockReturnValue({
      id: "claude-opus",
      label: "Claude Opus",
      backend: "claude",
      model: "claude-opus-4-6",
    } satisfies ModelPreset);

    applyModelPresetRuntime(task, aliasAgent!, { resolve });

    expect(resolve).toHaveBeenCalledWith("claude-opus");
    expect(task).toMatchObject({
      profileId: "roselin-opus",
      modelPreset: "claude-opus",
      model: "claude-opus-4-6",
      modelPresetBackend: "claude",
    });
  });

  it("keeps the persisted model and degrades to the profile backend when the preset was removed", () => {
    const task = makeTask({
      modelPreset: "removed-preset",
      model: "persisted-model",
    });
    const resolve = vi.fn(() => {
      throw new UnknownModelPresetError("removed-preset");
    });

    expect(applyModelPresetRuntime(task, agent, { resolve })).toBe(
      "preset_unavailable",
    );
    expect(task).toMatchObject({
      modelPreset: "removed-preset",
      model: "persisted-model",
    });
    expect(task.modelPresetBackend).toBeUndefined();
    expect(effectiveTaskBackend(task, agent)).toBe("codex");
  });
});

describe("effective turn preset", () => {
  const claudeOpus: ModelPreset = {
    id: "claude-opus",
    label: "Claude - Opus",
    backend: "claude",
    model: "opus",
    trusted_execution: true,
  };
  const codex61: ModelPreset = {
    id: "codex-6.1-sol",
    label: "Codex - 6.1 Sol",
    backend: "codex",
    model: "gpt-6.1-sol",
    trusted_execution: true,
  };
  const deepseek: ModelPreset = {
    id: "deepseek-flash-4.1",
    label: "DeepSeek - Flash 4.1",
    backend: "claude",
    model: "deepseek-v4.1-flash",
  };
  const presets: Record<string, ModelPreset> = {
    "claude-opus": claudeOpus,
    "codex-6.1-sol": codex61,
    "deepseek-flash-4.1": deepseek,
    "codex-sol": {
      id: "codex-sol",
      label: "Codex - 5.6 Sol",
      backend: "codex",
      model: "gpt-5.6-sol",
    },
  };
  const catalog = { resolve: (id: string) => presets[id]! };
  const seosoyoung: AgentProfile = {
    ...agent,
    id: "seosoyoung",
    name: "서소영",
    backend: "claude",
    default_preset: "claude-opus",
  };

  it("returns the same preset as the existing execution path for an explicit request", () => {
    const request = { model: null, modelPreset: "codex-6.1-sol" };

    expect(resolveEffectiveTurnPreset({ request }, agent, catalog)).toEqual(
      resolveModelPresetSelection(request, agent, catalog),
    );
  });

  it("uses the stored preset when the request omits a selection", () => {
    const stored = { model: "gpt-6.1-sol", modelPreset: "codex-6.1-sol" };

    expect(
      resolveEffectiveTurnPreset({ stored }, agent, catalog),
    ).toEqual(resolveModelPresetSelection(stored, agent, catalog));
  });

  it("keeps the seosoyoung claude-opus default path when nothing is selected", () => {
    expect(
      resolveEffectiveTurnPreset(
        { request: { model: null, modelPreset: null }, stored: { model: null, modelPreset: null } },
        seosoyoung,
        catalog,
      )?.id,
    ).toBe("claude-opus");
    expect(resolveEffectiveTurnPreset({}, seosoyoung, catalog)?.id).toBe("claude-opus");
  });

  it("does not treat a stored raw model as a preset selection", () => {
    expect(
      resolveEffectiveTurnPreset(
        { stored: { model: "opus", modelPreset: null } },
        seosoyoung,
        catalog,
      ),
    ).toBeUndefined();
  });

  it("does not let a request raw model fall through to the stored preset", () => {
    expect(
      resolveEffectiveTurnPreset(
        {
          request: { model: "raw-model", modelPreset: null },
          stored: { model: "gpt-6.1-sol", modelPreset: "codex-6.1-sol" },
        },
        agent,
        catalog,
      ),
    ).toBeUndefined();
  });

  it("drops a removed stored preset to no selection", () => {
    const resolve = vi.fn(() => {
      throw new UnknownModelPresetError("removed-preset");
    });

    expect(
      resolveEffectiveTurnPreset(
        { stored: { model: "persisted-model", modelPreset: "removed-preset" } },
        agent,
        { resolve },
      ),
    ).toBeUndefined();
  });

  it("keeps the existing unknown-preset error for an explicit request", () => {
    expect(() =>
      resolveEffectiveTurnPreset(
        { request: { model: null, modelPreset: "removed-preset" } },
        agent,
        {
          resolve: () => {
            throw new UnknownModelPresetError("removed-preset");
          },
        },
      ),
    ).toThrow(UnknownModelPresetError);
  });

  it("returns no preset when request, stored value, and agent default are absent", () => {
    expect(
      resolveEffectiveTurnPreset(
        { request: { model: null, modelPreset: null }, stored: { model: null, modelPreset: null } },
        { ...agent, default_preset: null },
        catalog,
      ),
    ).toBeUndefined();
  });
});
