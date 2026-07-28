import { describe, expect, it } from "vitest";

import { InMemoryNodeRegistry } from "../src/node/registry.js";
import {
  selectNodeForSessionCreate,
  SessionCreateNodeSelectionError,
} from "../src/session/session_create_node_selector.js";

function registryWithPreset(): InMemoryNodeRegistry {
  const registry = new InMemoryNodeRegistry();
  registry.registerNode({
    type: "node_register",
    node_id: "node-a",
    agents: [
      {
        id: "roselin",
        backend: "claude",
        default_preset: "codex-sol",
        aliases: [
          {
            id: "roselin-opus",
            default_preset: "claude-opus",
          },
        ],
      },
    ],
    supported_backends: ["claude", "codex"],
    model_presets: [
      {
        id: "codex-sol",
        label: "Codex - 5.6 Sol",
        backend: "codex",
        available: true,
        usage_provider: "codex",
        usage_model_id: "gpt-5.6-sol",
      },
      {
        id: "claude-opus",
        label: "Claude - Opus",
        backend: "claude",
        available: true,
        usage_provider: "claude",
        usage_model_id: "claude-opus-4-1",
      },
    ],
  });
  return registry;
}

describe("session create node selection with model presets", () => {
  it("selects the explicit preset backend instead of the profile backend", () => {
    const selected = selectNodeForSessionCreate(registryWithPreset(), {
      nodeId: "node-a",
      profileId: "roselin",
      modelPresetId: "codex-sol",
    });

    expect(selected.backend).toBe("codex");
  });

  it("uses the profile default preset only when a legacy model was not specified", () => {
    const registry = registryWithPreset();

    expect(selectNodeForSessionCreate(registry, {
      nodeId: "node-a",
      profileId: "roselin",
    })).toMatchObject({
      backend: "codex",
      modelPresetId: "codex-sol",
    });
    expect(selectNodeForSessionCreate(registry, {
      nodeId: "node-a",
      profileId: "roselin",
      legacyModelSpecified: true,
    }).backend).toBe("claude");
  });

  it("alias 조회는 canonical profile id와 alias별 default preset을 선택한다", () => {
    expect(selectNodeForSessionCreate(registryWithPreset(), {
      nodeId: "node-a",
      profileId: "roselin-opus",
    })).toMatchObject({
      profileId: "roselin",
      backend: "claude",
      modelPresetId: "claude-opus",
    });
  });

  it("rejects an unadvertised preset with a 400 contract error", () => {
    try {
      selectNodeForSessionCreate(registryWithPreset(), {
        nodeId: "node-a",
        profileId: "roselin",
        modelPresetId: "missing",
      });
      throw new Error("expected selection to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionCreateNodeSelectionError);
      expect(error).toMatchObject({
        statusCode: 400,
        code: "MODEL_PRESET_NOT_FOUND",
      });
    }
  });
});
