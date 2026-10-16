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
