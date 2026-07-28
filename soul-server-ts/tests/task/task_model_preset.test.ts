import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { ModelPreset } from "../../src/model_catalog.js";
import {
  applyModelPresetRuntime,
  effectiveTaskBackend,
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
});
