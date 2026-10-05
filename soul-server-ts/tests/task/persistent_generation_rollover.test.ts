import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import { UnknownModelPresetError } from "../../src/model_catalog.js";
import {
  beginGenerationRolloverIfPending,
} from "../../src/task/persistent_generation_rollover.js";
import type { Task } from "../../src/task/task_models.js";

const agent: AgentProfile = {
  id: "agent-1",
  name: "Agent",
  backend: "claude",
  workspace_dir: "/tmp/agent",
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "session-1",
    prompt: "unused initial prompt",
    status: "running",
    persistent: true,
    codexThreadId: "native-old",
    modelPreset: "claude-old",
    model: "claude-model-old",
    modelPresetBackend: "claude",
    modelPresetEnv: { CLAUDE_PROFILE: "old" },
    persistentGeneration: {
      number: 1,
      backendSessionId: "native-old",
      pending: {
        number: 2,
        reason: "context limit",
        requestedAt: "2026-10-05T00:00:00.000Z",
        targetModelPreset: "codex-new",
        targetReasoningEffort: "high",
      },
    },
    createdAt: new Date("2026-10-05T00:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [{ text: "continue" }],
    ...overrides,
  };
}

function makeCatalog() {
  return {
    resolve: vi.fn((id: string) => {
      if (id === "codex-new") {
        return {
          id,
          label: "Codex New",
          backend: "codex" as const,
          model: "codex-model-new",
          env: { CODEX_PROFILE: "new" },
          supported_efforts: ["high" as const],
        };
      }
      throw new UnknownModelPresetError(id);
    }),
  };
}

describe("beginGenerationRolloverIfPending", () => {
  it("applies a requested generation to a persistent session with queued input", () => {
    const task = makeTask();
    const catalog = makeCatalog();

    const rollover = beginGenerationRolloverIfPending(task, agent, catalog);

    expect(rollover).toEqual({
      number: 2,
      reason: "context limit",
      fromBackendSessionId: "native-old",
      previousModelPreset: "claude-old",
      previousBackend: "claude",
    });
    expect(task.modelPreset).toBe("codex-new");
    expect(task.model).toBe("codex-model-new");
    expect(task.modelPresetBackend).toBe("codex");
    expect(task.modelPresetEnv).toEqual({ CODEX_PROFILE: "new" });
    expect(task.reasoningEffort).toBe("high");
    expect(task.claudeContextUsage).toBeUndefined();
  });

  it.each([
    ["persistent marker off", { persistent: false }],
    ["queue empty", { interventionQueue: [] }],
    ["native id absent", { codexThreadId: undefined }],
    ["retained runner", { runnerRetainedForDetachedWork: true }],
    ["runtime follow-up is first", {
      interventionQueue: [{ text: "background result", source: "claude_runtime_task_followup" }],
    }],
  ])("leaves a requested generation pending when %s", (_label, overrides) => {
    const task = makeTask(overrides);
    const catalog = makeCatalog();

    const rollover = beginGenerationRolloverIfPending(task, agent, catalog);

    expect(rollover).toBeUndefined();
    expect(task.persistentGeneration?.pending?.applyingFrom).toBeUndefined();
    expect(task.modelPreset).toBe("claude-old");
    expect(catalog.resolve).not.toHaveBeenCalled();
  });

  it("continues an applying generation despite a disabled marker and empty queue", () => {
    const task = makeTask({
      persistent: false,
      interventionQueue: [],
      persistentGeneration: {
        number: 1,
        pending: {
          number: 2,
          reason: "context limit",
          requestedAt: "2026-10-05T00:00:00.000Z",
          targetModelPreset: "codex-new",
          targetReasoningEffort: "high",
          applyingFrom: "native-old",
        },
      },
    });

    const rollover = beginGenerationRolloverIfPending(task, agent, makeCatalog());

    expect(rollover?.fromBackendSessionId).toBe("native-old");
    expect(task.modelPresetBackend).toBe("codex");
  });
});
